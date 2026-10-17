import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "../../../prisma/generated/client/client.js";
import { PrismaService } from "../../shared/database/prisma.service.js";
import {
  firstOccurrenceOnOrAfter,
  followingOccurrence,
  localDateAt,
  localSlotUtc,
  nextCycleOccurrence,
  shiftDate,
} from "./schedule.js";

type FamilyScope = { id: string; membershipId: string };
type TaskCreate = {
  title: string;
  description?: string | null | undefined;
  dueOn: string;
  familyId?: string | null | undefined;
  assigneeId?: string | null | undefined;
};
type TaskPatch = {
  version: number;
  title?: string | undefined;
  description?: string | null | undefined;
  dueOn?: string | undefined;
  assigneeId?: string | null | undefined;
};
type RecurringCreate = {
  title: string;
  categoryId: string;
  frequency: "MONTHLY" | "YEARLY";
  anchorOn: string;
  expectedAmount?: string | null | undefined;
  familyId?: string | null | undefined;
};
type RecurringPatch = {
  version: number;
  title?: string | undefined;
  categoryId?: string | undefined;
  frequency?: "MONTHLY" | "YEARLY" | undefined;
  anchorOn?: string | undefined;
  expectedAmount?: string | null | undefined;
};

const recurringRuleListInclude = {
  category: { select: { id: true, name: true, code: true } },
  occurrences: {
    orderBy: [{ dueOn: "desc" }, { id: "desc" }],
    take: 13,
    include: {
      activeExpense: { select: { id: true, payerId: true, amountCents: true } },
      manager: { select: { id: true, nickname: true } },
    },
  },
} satisfies Prisma.RecurringRuleInclude;

function asDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateString(value: Date) {
  return value.toISOString().slice(0, 10);
}

function cents(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function money(value: bigint) {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function hashRequest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

@Injectable()
export class TasksService implements OnModuleInit, OnModuleDestroy {
  private reminderTimer: ReturnType<typeof setInterval> | undefined;
  private reminderScanRunning = false;
  private readonly logger = new Logger(TasksService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.RUN_REMINDER_LOOP !== "true") return;
    const scan = () => {
      if (this.reminderScanRunning) return;
      this.reminderScanRunning = true;
      void this.runReminderCycle()
        .catch((error: unknown) => {
          this.logger.error(
            "Reminder cycle failed",
            error instanceof Error ? error.stack : String(error),
          );
        })
        .finally(() => {
          this.reminderScanRunning = false;
        });
    };
    scan();
    this.reminderTimer = setInterval(scan, 60_000);
  }

  onModuleDestroy() {
    if (this.reminderTimer) clearInterval(this.reminderTimer);
  }

  private async familyScope(
    tx: Prisma.TransactionClient,
    accountId: string,
    familyId: string | null | undefined,
  ): Promise<FamilyScope | null> {
    if (!familyId) return null;
    await tx.$executeRaw`UPDATE families SET version = version WHERE id = ${familyId}::uuid`;
    const family = await tx.family.findUnique({ where: { id: familyId } });
    const membership = await tx.membership.findFirst({
      where: {
        familyId,
        accountId,
        leftAt: null,
        account: { status: "ACTIVE" },
      },
      select: { id: true },
    });
    if (!family || !membership)
      throw new NotFoundException({ code: "FAMILY_NOT_FOUND" });
    if (family.status !== "ACTIVE")
      throw new ConflictException({ code: "FAMILY_ARCHIVED" });
    return { id: family.id, membershipId: membership.id };
  }

  private async assertTaskRead(
    task: { familyId: string | null; creatorId: string; managerId: string },
    accountId: string,
  ) {
    if (task.familyId) {
      const member = await this.prisma.membership.findFirst({
        where: {
          familyId: task.familyId,
          accountId,
          leftAt: null,
          account: { status: "ACTIVE" },
        },
        select: { id: true },
      });
      if (!member) throw new NotFoundException({ code: "TASK_NOT_FOUND" });
    } else if (task.creatorId !== accountId) {
      throw new NotFoundException({ code: "TASK_NOT_FOUND" });
    }
  }

  private async assertTaskManager(
    tx: Prisma.TransactionClient,
    task: {
      familyId: string | null;
      managerId: string;
      managerMembershipId: string | null;
    },
    accountId: string,
  ) {
    if (task.familyId) {
      const scope = await this.familyScope(tx, accountId, task.familyId);
      if (
        !scope ||
        task.managerId !== accountId ||
        task.managerMembershipId !== scope.membershipId
      ) {
        throw new ForbiddenException({ code: "TASK_MANAGER_REQUIRED" });
      }
    } else if (task.managerId !== accountId) {
      throw new ForbiddenException({ code: "TASK_MANAGER_REQUIRED" });
    }
  }

  async listTasks(
    accountId: string,
    input: {
      space: "personal" | "family";
      familyId?: string | undefined;
      status: "all" | "open" | "done";
      cursor?: string | undefined;
      limit: number;
    },
  ) {
    let currentFamilyMembershipId: string | null = null;
    const where: Prisma.TaskWhereInput = {
      deletedAt: null,
      ...(input.status === "open" ? { status: "OPEN" } : {}),
      ...(input.status === "done" ? { status: "DONE" } : {}),
      ...(input.space === "personal"
        ? { familyId: null, creatorId: accountId }
        : { familyId: input.familyId! }),
    };
    if (input.space === "family") {
      const membership = await this.prisma.membership.findFirst({
        where: { familyId: input.familyId!, accountId, leftAt: null },
        select: { id: true },
      });
      if (!membership)
        throw new NotFoundException({ code: "FAMILY_NOT_FOUND" });
      currentFamilyMembershipId = membership.id;
    }
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.task.findMany({
        where,
        include: {
          manager: { select: { id: true, nickname: true } },
          assignee: { select: { id: true, nickname: true } },
          completedBy: { select: { id: true, nickname: true } },
        },
        orderBy: [
          { status: "asc" },
          { dueOn: "asc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      return {
        items: page.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          dueOn: dateString(task.dueOn),
          familyId: task.familyId,
          status: task.status,
          manager: task.manager,
          assignee: task.assignee,
          completedBy: task.completedBy,
          completedAt: task.completedAt?.toISOString() ?? null,
          version: task.version,
          canManage:
            task.managerId === accountId &&
            (!task.familyId ||
              task.managerMembershipId === currentFamilyMembershipId),
          canComplete: task.status === "OPEN",
        })),
        nextCursor: hasMore ? page.at(-1)!.id : null,
      };
    });
  }

  async getTask(taskId: string, accountId: string) {
    const task = await this.prisma.$transaction((tx) =>
      tx.task.findUnique({
        where: { id: taskId },
        include: {
          manager: { select: { id: true, nickname: true } },
          assignee: { select: { id: true, nickname: true } },
          completedBy: { select: { id: true, nickname: true } },
        },
      }),
    );
    if (!task || task.deletedAt)
      throw new NotFoundException({ code: "TASK_NOT_FOUND" });
    await this.assertTaskRead(task, accountId);
    const membership = task.familyId
      ? await this.prisma.membership.findFirst({
          where: { familyId: task.familyId, accountId, leftAt: null },
          select: { id: true },
        })
      : null;
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      dueOn: dateString(task.dueOn),
      familyId: task.familyId,
      status: task.status,
      manager: task.manager,
      assignee: task.assignee,
      completedBy: task.completedBy,
      completedAt: task.completedAt?.toISOString() ?? null,
      version: task.version,
      canManage:
        task.managerId === accountId &&
        (!task.familyId || task.managerMembershipId === membership?.id),
      canComplete: task.status === "OPEN",
    };
  }

  async createTask(accountId: string, input: TaskCreate) {
    return this.prisma.$transaction(async (tx) => {
      const family = await this.familyScope(tx, accountId, input.familyId);
      if (input.assigneeId) {
        if (!family)
          throw new ConflictException({
            code: "TASK_ASSIGNEE_REQUIRES_FAMILY",
          });
        const assignee = await tx.membership.findFirst({
          where: {
            familyId: family.id,
            accountId: input.assigneeId,
            leftAt: null,
            account: { status: "ACTIVE" },
          },
          select: { id: true },
        });
        if (!assignee)
          throw new ConflictException({ code: "TASK_ASSIGNEE_UNAVAILABLE" });
      }
      const task = await tx.task.create({
        data: {
          creatorId: accountId,
          managerId: accountId,
          managerMembershipId: family?.membershipId ?? null,
          familyId: family?.id ?? null,
          assigneeId: input.assigneeId ?? null,
          title: input.title,
          description: input.description || null,
          dueOn: asDate(input.dueOn),
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "TASK_CREATED",
          subjectType: "TASK",
          subjectId: task.id,
          details: { familyId: family?.id ?? null, dueOn: input.dueOn },
        },
      });
      return { id: task.id, version: task.version, status: task.status };
    });
  }

  async updateTask(taskId: string, accountId: string, input: TaskPatch) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.task.findUnique({ where: { id: taskId } });
      if (!current || current.deletedAt)
        throw new NotFoundException({ code: "TASK_NOT_FOUND" });
      await this.assertTaskManager(tx, current, accountId);
      if (current.version !== input.version)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      if (input.assigneeId && !current.familyId) {
        throw new ConflictException({ code: "TASK_ASSIGNEE_REQUIRES_FAMILY" });
      }
      if (input.assigneeId && current.familyId) {
        const assignee = await tx.membership.findFirst({
          where: {
            familyId: current.familyId,
            accountId: input.assigneeId,
            leftAt: null,
            account: { status: "ACTIVE" },
          },
          select: { id: true },
        });
        if (!assignee)
          throw new ConflictException({ code: "TASK_ASSIGNEE_UNAVAILABLE" });
      }
      const changed = await tx.task.updateMany({
        where: { id: taskId, version: input.version, deletedAt: null },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined
            ? { description: input.description || null }
            : {}),
          ...(input.dueOn !== undefined ? { dueOn: asDate(input.dueOn) } : {}),
          ...(input.assigneeId !== undefined
            ? { assigneeId: input.assigneeId }
            : {}),
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const updated = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "TASK_UPDATED",
          subjectType: "TASK",
          subjectId: taskId,
          details: { version: updated.version },
        },
      });
      return { id: updated.id, version: updated.version };
    });
  }

  async deleteTask(taskId: string, accountId: string, version: number) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.task.findUnique({ where: { id: taskId } });
      if (!current || current.deletedAt)
        throw new NotFoundException({ code: "TASK_NOT_FOUND" });
      await this.assertTaskManager(tx, current, accountId);
      if (current.version !== version)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const changed = await tx.task.updateMany({
        where: { id: taskId, version, deletedAt: null },
        data: { deletedAt: new Date(), version: { increment: 1 } },
      });
      if (changed.count !== 1)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "TASK_DELETED",
          subjectType: "TASK",
          subjectId: taskId,
        },
      });
      return { deleted: true, id: taskId };
    });
  }

  async completeTask(taskId: string, accountId: string, version: number) {
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id: taskId } });
      if (!task || task.deletedAt)
        throw new NotFoundException({ code: "TASK_NOT_FOUND" });
      if (task.familyId) await this.familyScope(tx, accountId, task.familyId);
      else if (task.managerId !== accountId)
        throw new NotFoundException({ code: "TASK_NOT_FOUND" });
      if (task.version !== version || task.status !== "OPEN")
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const changed = await tx.task.updateMany({
        where: { id: taskId, version, status: "OPEN", deletedAt: null },
        data: {
          status: "DONE",
          completedById: accountId,
          completedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const updated = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "TASK_COMPLETED",
          subjectType: "TASK",
          subjectId: taskId,
        },
      });
      return {
        id: updated.id,
        status: updated.status,
        version: updated.version,
      };
    });
  }

  async reopenTask(taskId: string, accountId: string, version: number) {
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id: taskId } });
      if (!task || task.deletedAt)
        throw new NotFoundException({ code: "TASK_NOT_FOUND" });
      await this.assertTaskManager(tx, task, accountId);
      if (task.version !== version || task.status !== "DONE")
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const changed = await tx.task.updateMany({
        where: { id: taskId, version, status: "DONE", deletedAt: null },
        data: {
          status: "OPEN",
          completedById: null,
          completedAt: null,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const updated = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "TASK_REOPENED",
          subjectType: "TASK",
          subjectId: taskId,
        },
      });
      return {
        id: updated.id,
        status: updated.status,
        version: updated.version,
      };
    });
  }

  private async assertRuleManager(
    tx: Prisma.TransactionClient,
    rule: {
      familyId: string | null;
      managerId: string;
      managerMembershipId: string | null;
    },
    accountId: string,
  ) {
    const family = rule.familyId
      ? await this.familyScope(tx, accountId, rule.familyId)
      : null;
    if (
      rule.managerId !== accountId ||
      (rule.familyId && rule.managerMembershipId !== family?.membershipId)
    )
      throw new ForbiddenException({ code: "RECURRING_MANAGER_REQUIRED" });
  }

  async listRecurring(
    accountId: string,
    input: {
      space: "personal" | "family";
      familyId?: string | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ) {
    if (input.space === "family") {
      const membership = await this.prisma.membership.findFirst({
        where: { familyId: input.familyId!, accountId, leftAt: null },
        select: { id: true },
      });
      if (!membership)
        throw new NotFoundException({ code: "FAMILY_NOT_FOUND" });
    }
    return this.prisma.$transaction(async (tx) => {
      const currentMembership = input.familyId
        ? await tx.membership.findFirst({
            where: { familyId: input.familyId, accountId, leftAt: null },
            select: { id: true },
          })
        : null;
      const rows = await tx.recurringRule.findMany({
        where:
          input.space === "personal"
            ? { familyId: null, creatorId: accountId }
            : { familyId: input.familyId! },
        include: recurringRuleListInclude,
        orderBy: [{ status: "asc" }, { anchorOn: "asc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      return {
        items: page.map((rule) => ({
          id: rule.id,
          title: rule.title,
          familyId: rule.familyId,
          category: rule.category,
          frequency: rule.frequency,
          anchorOn: dateString(rule.anchorOn),
          expectedAmount:
            rule.expectedCents === null ? null : money(rule.expectedCents),
          status: rule.status,
          version: rule.version,
          canManage:
            rule.managerId === accountId &&
            (!rule.familyId ||
              rule.managerMembershipId === currentMembership?.id),
          occurrencesNextCursor:
            rule.occurrences.length > 12
              ? (rule.occurrences[11]?.id ?? null)
              : null,
          occurrences: rule.occurrences.slice(0, 12).map((occurrence) => ({
            id: occurrence.id,
            periodKey: occurrence.periodKey,
            dueOn: dateString(occurrence.dueOn),
            title: occurrence.titleSnapshot,
            status: occurrence.status,
            version: occurrence.version,
            amount:
              occurrence.activeExpense?.amountCents === undefined
                ? null
                : money(occurrence.activeExpense.amountCents),
            payerId: occurrence.activeExpense?.payerId ?? null,
            manager: occurrence.manager,
            canPay: occurrence.status === "PENDING",
            canSkip:
              occurrence.status === "PENDING" &&
              occurrence.managerId === accountId,
          })),
        })),
        nextCursor: hasMore ? page.at(-1)!.id : null,
      };
    });
  }

  async listOccurrences(
    ruleId: string,
    accountId: string,
    input: { cursor?: string | undefined; limit: number } = { limit: 30 },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.recurringRule.findUnique({
        where: { id: ruleId },
        select: { id: true, familyId: true, managerId: true },
      });
      if (!rule)
        throw new NotFoundException({ code: "RECURRING_RULE_NOT_FOUND" });
      if (rule.familyId) {
        const membership = await tx.membership.findFirst({
          where: { familyId: rule.familyId, accountId, leftAt: null },
          select: { id: true },
        });
        if (!membership)
          throw new NotFoundException({ code: "RECURRING_RULE_NOT_FOUND" });
      } else if (rule.managerId !== accountId) {
        throw new NotFoundException({ code: "RECURRING_RULE_NOT_FOUND" });
      }
      const rows = await tx.occurrence.findMany({
        where: { ruleId },
        orderBy: [{ dueOn: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        include: {
          activeExpense: { select: { amountCents: true, payerId: true } },
          manager: { select: { id: true, nickname: true } },
        },
      });
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      return {
        items: page.map((occurrence) => ({
          id: occurrence.id,
          periodKey: occurrence.periodKey,
          dueOn: dateString(occurrence.dueOn),
          title: occurrence.titleSnapshot,
          status: occurrence.status,
          version: occurrence.version,
          amount:
            occurrence.activeExpense?.amountCents === undefined
              ? null
              : money(occurrence.activeExpense.amountCents),
          payerId: occurrence.activeExpense?.payerId ?? null,
          manager: occurrence.manager,
          canPay: occurrence.status === "PENDING",
          canSkip:
            occurrence.status === "PENDING" &&
            occurrence.managerId === accountId,
        })),
        nextCursor: hasMore ? page.at(-1)!.id : null,
      };
    });
  }

  async createRecurring(accountId: string, input: RecurringCreate) {
    return this.prisma.$transaction(async (tx) => {
      const family = await this.familyScope(tx, accountId, input.familyId);
      const category = await tx.category.findUnique({
        where: { id: input.categoryId },
        select: { id: true, isActive: true },
      });
      if (!category?.isActive)
        throw new ConflictException({ code: "CATEGORY_UNAVAILABLE" });
      const rule = await tx.recurringRule.create({
        data: {
          familyId: family?.id ?? null,
          creatorId: accountId,
          managerId: accountId,
          managerMembershipId: family?.membershipId ?? null,
          title: input.title,
          categoryId: input.categoryId,
          frequency: input.frequency,
          anchorOn: asDate(input.anchorOn),
          effectiveFromOn: asDate(
            input.anchorOn > localDateAt(new Date())
              ? input.anchorOn
              : localDateAt(new Date()),
          ),
          expectedCents: input.expectedAmount
            ? cents(input.expectedAmount)
            : null,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "RECURRING_RULE_CREATED",
          subjectType: "RECURRING_RULE",
          subjectId: rule.id,
          details: { familyId: family?.id ?? null },
        },
      });
      return { id: rule.id, version: rule.version, status: rule.status };
    });
  }

  async updateRecurring(
    ruleId: string,
    accountId: string,
    input: RecurringPatch,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.recurringRule.findUnique({
        where: { id: ruleId },
      });
      if (!current)
        throw new NotFoundException({ code: "RECURRING_RULE_NOT_FOUND" });
      await this.assertRuleManager(tx, current, accountId);
      if (current.version !== input.version)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      if (input.categoryId) {
        const category = await tx.category.findUnique({
          where: { id: input.categoryId },
        });
        if (!category?.isActive)
          throw new ConflictException({ code: "CATEGORY_UNAVAILABLE" });
      }
      const nextFrequency = input.frequency ?? current.frequency;
      const nextAnchorOn = asDate(
        input.anchorOn ?? dateString(current.anchorOn),
      );
      const nextSchedule = nextCycleOccurrence(
        nextFrequency,
        nextAnchorOn,
        new Date(),
      );
      const effectiveFromOn =
        nextSchedule.localDueOn > dateString(nextAnchorOn)
          ? nextSchedule.dueOn
          : nextAnchorOn;
      const changed = await tx.recurringRule.updateMany({
        where: { id: ruleId, version: input.version },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.categoryId !== undefined
            ? { categoryId: input.categoryId }
            : {}),
          ...(input.frequency !== undefined
            ? { frequency: input.frequency }
            : {}),
          ...(input.anchorOn !== undefined
            ? { anchorOn: asDate(input.anchorOn) }
            : {}),
          ...(current.status === "ACTIVE" ? { effectiveFromOn } : {}),
          ...(input.expectedAmount !== undefined
            ? {
                expectedCents: input.expectedAmount
                  ? cents(input.expectedAmount)
                  : null,
              }
            : {}),
          scheduleRevision: { increment: 1 },
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const updated = await tx.recurringRule.findUniqueOrThrow({
        where: { id: ruleId },
      });
      return { id: updated.id, version: updated.version };
    });
  }

  async setRecurringStatus(
    ruleId: string,
    accountId: string,
    version: number,
    status: "ACTIVE" | "PAUSED",
  ) {
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.recurringRule.findUnique({ where: { id: ruleId } });
      if (!rule)
        throw new NotFoundException({ code: "RECURRING_RULE_NOT_FOUND" });
      await this.assertRuleManager(tx, rule, accountId);
      if (rule.version !== version)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      if (rule.status === status)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const changed = await tx.recurringRule.updateMany({
        where: { id: ruleId, version, status: rule.status },
        data: {
          status,
          ...(status === "ACTIVE"
            ? {
                effectiveFromOn: (() => {
                  const next = nextCycleOccurrence(
                    rule.frequency,
                    rule.anchorOn,
                    new Date(),
                  );
                  return next.localDueOn > dateString(rule.anchorOn)
                    ? next.dueOn
                    : rule.anchorOn;
                })(),
              }
            : {}),
          version: { increment: 1 },
          scheduleRevision: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const updated = await tx.recurringRule.findUniqueOrThrow({
        where: { id: ruleId },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action:
            status === "PAUSED"
              ? "RECURRING_RULE_PAUSED"
              : "RECURRING_RULE_RESUMED",
          subjectType: "RECURRING_RULE",
          subjectId: ruleId,
        },
      });
      return {
        id: updated.id,
        status: updated.status,
        version: updated.version,
      };
    });
  }

  async skipOccurrence(
    occurrenceId: string,
    accountId: string,
    version: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE occurrences SET version = version WHERE id = ${occurrenceId}::uuid`;
      const occurrence = await tx.occurrence.findUnique({
        where: { id: occurrenceId },
        include: {
          rule: {
            select: {
              familyId: true,
              managerId: true,
              managerMembershipId: true,
            },
          },
        },
      });
      if (!occurrence)
        throw new NotFoundException({ code: "OCCURRENCE_NOT_FOUND" });
      await this.assertRuleManager(tx, occurrence.rule, accountId);
      if (occurrence.version !== version || occurrence.status !== "PENDING")
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const updated = await tx.occurrence.update({
        where: { id: occurrenceId },
        data: { status: "SKIPPED", version: { increment: 1 } },
      });
      return {
        id: updated.id,
        status: updated.status,
        version: updated.version,
      };
    });
  }

  private async idempotent<T>(
    accountId: string,
    key: string,
    input: unknown,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    const hash = hashRequest(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const where = {
          actorId_operation_key: {
            actorId: accountId,
            operation: "occurrence.pay",
            key,
          },
        };
        const existing = await tx.idempotencyRecord.findUnique({ where });
        if (existing && existing.expiresAt > new Date()) {
          if (existing.requestHash !== hash)
            throw new ConflictException({ code: "IDEMPOTENCY_MISMATCH" });
          if (existing.response === null)
            throw new ConflictException({ code: "IDEMPOTENCY_IN_PROGRESS" });
          return existing.response as T;
        }
        if (existing)
          await tx.idempotencyRecord.delete({ where: { id: existing.id } });
        const reservation = await tx.idempotencyRecord.create({
          data: {
            actorId: accountId,
            operation: "occurrence.pay",
            key,
            requestHash: hash,
            response: Prisma.DbNull,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        });
        const result = await operation(tx);
        await tx.idempotencyRecord.update({
          where: { id: reservation.id },
          data: { response: result as Prisma.InputJsonValue },
        });
        return result;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: {
            actorId_operation_key: {
              actorId: accountId,
              operation: "occurrence.pay",
              key,
            },
          },
        });
        if (existing?.response !== null && existing?.response !== undefined) {
          if (existing.requestHash !== hash)
            throw new ConflictException({ code: "IDEMPOTENCY_MISMATCH" });
          return existing.response as T;
        }
      }
      throw error;
    }
  }

  async payOccurrence(
    occurrenceId: string,
    accountId: string,
    input: { amount: string; occurredOn: string; version: number },
    key: string,
  ) {
    return this.idempotent(
      accountId,
      key,
      { occurrenceId, ...input },
      async (tx) => {
        await tx.$executeRaw`UPDATE occurrences SET version = version WHERE id = ${occurrenceId}::uuid`;
        const occurrence = await tx.occurrence.findUnique({
          where: { id: occurrenceId },
          include: { rule: true },
        });
        if (!occurrence)
          throw new NotFoundException({ code: "OCCURRENCE_NOT_FOUND" });
        if (occurrence.rule.familyId)
          await this.familyScope(tx, accountId, occurrence.rule.familyId);
        else if (occurrence.rule.managerId !== accountId)
          throw new NotFoundException({ code: "OCCURRENCE_NOT_FOUND" });
        if (occurrence.status === "SKIPPED")
          throw new ConflictException({ code: "PERIOD_SKIPPED" });
        if (
          occurrence.status !== "PENDING" ||
          occurrence.version !== input.version
        )
          throw new ConflictException({ code: "PERIOD_ALREADY_PAID" });
        const category = await tx.category.findUnique({
          where: { id: occurrence.categoryIdSnapshot },
        });
        if (!category)
          throw new ConflictException({ code: "CATEGORY_UNAVAILABLE" });
        const expense = await tx.expense.create({
          data: {
            payerId: accountId,
            familyId: occurrence.rule.familyId,
            categoryId: occurrence.categoryIdSnapshot,
            occurrenceId,
            title: occurrence.titleSnapshot,
            occurredOn: asDate(input.occurredOn),
            amountCents: cents(input.amount),
          },
        });
        const updated = await tx.occurrence.update({
          where: { id: occurrenceId },
          data: {
            status: "PAID",
            activeExpenseId: expense.id,
            version: { increment: 1 },
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: accountId,
            action: "OCCURRENCE_PAID",
            subjectType: "OCCURRENCE",
            subjectId: occurrenceId,
            details: { expenseId: expense.id, amount: input.amount },
          },
        });
        return {
          id: updated.id,
          status: updated.status,
          version: updated.version,
          expenseId: expense.id,
        };
      },
    );
  }

  async getReminderPreference(accountId: string) {
    const preference = await this.prisma.reminderPreference.upsert({
      where: { accountId },
      create: { accountId },
      update: {},
    });
    return {
      localTime: preference.localTime,
      taskAdvanceDays: preference.taskAdvanceDays,
      feeAdvanceDays: preference.feeAdvanceDays,
      overdueEnabled: preference.overdueEnabled,
    };
  }

  async updateReminderPreference(
    accountId: string,
    input: {
      localTime: string;
      taskAdvanceDays: number;
      feeAdvanceDays: number;
      overdueEnabled: boolean;
    },
  ) {
    const preference = await this.prisma.reminderPreference.upsert({
      where: { accountId },
      create: { accountId, ...input },
      update: input,
    });
    await this.prisma.auditEvent.create({
      data: {
        actorId: accountId,
        action: "REMINDER_PREFERENCES_UPDATED",
        subjectType: "ACCOUNT",
        subjectId: accountId,
      },
    });
    return {
      localTime: preference.localTime,
      taskAdvanceDays: preference.taskAdvanceDays,
      feeAdvanceDays: preference.feeAdvanceDays,
      overdueEnabled: preference.overdueEnabled,
    };
  }

  async listNotifications(
    accountId: string,
    input: { cursor?: string | undefined; limit: number } = { limit: 30 },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const messages = await tx.inboxMessage.findMany({
        where: { recipientId: accountId },
        orderBy: [{ slotAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        include: { items: true },
      });
      const hasMore = messages.length > input.limit;
      const page = hasMore ? messages.slice(0, input.limit) : messages;
      const visible = [];
      for (const message of page) {
        const items = [];
        for (const item of message.items) {
          if (item.subjectType === "TASK") {
            const task = await tx.task.findUnique({
              where: { id: item.subjectId },
              select: {
                id: true,
                title: true,
                familyId: true,
                creatorId: true,
                status: true,
                deletedAt: true,
              },
            });
            if (!task || task.deletedAt || task.status !== "OPEN") continue;
            if (task.familyId) {
              const membership = await tx.membership.findFirst({
                where: {
                  familyId: task.familyId,
                  accountId,
                  leftAt: null,
                  account: { status: "ACTIVE" },
                  family: { status: "ACTIVE" },
                },
                select: { id: true },
              });
              if (!membership) continue;
            } else if (task.creatorId !== accountId) continue;
            items.push({
              id: item.id,
              subjectType: item.subjectType,
              subjectId: item.subjectId,
              reminderKind: item.reminderKind,
              scheduledOn: dateString(item.scheduledOn),
              title: task.title,
            });
          } else if (item.subjectType === "OCCURRENCE") {
            const occurrence = await tx.occurrence.findUnique({
              where: { id: item.subjectId },
              include: {
                rule: {
                  select: { familyId: true, managerId: true, title: true },
                },
              },
            });
            if (!occurrence || occurrence.status !== "PENDING") continue;
            if (occurrence.rule.familyId) {
              const membership = await tx.membership.findFirst({
                where: {
                  familyId: occurrence.rule.familyId,
                  accountId,
                  leftAt: null,
                  account: { status: "ACTIVE" },
                  family: { status: "ACTIVE" },
                },
                select: { id: true },
              });
              if (!membership) continue;
            } else if (occurrence.rule.managerId !== accountId) continue;
            items.push({
              id: item.id,
              subjectType: item.subjectType,
              subjectId: item.subjectId,
              reminderKind: item.reminderKind,
              scheduledOn: dateString(item.scheduledOn),
              title: occurrence.titleSnapshot || occurrence.rule.title,
              periodKey: occurrence.periodKey,
            });
          }
        }
        if (items.length || message.readAt) {
          visible.push({
            id: message.id,
            slotAt: message.slotAt.toISOString(),
            readAt: message.readAt?.toISOString() ?? null,
            unreadCount: message.readAt ? 0 : items.length,
            items,
          });
        }
      }
      return {
        items: visible,
        nextCursor: hasMore ? page.at(-1)!.id : null,
      };
    });
  }

  async markNotificationRead(messageId: string, accountId: string) {
    const changed = await this.prisma.inboxMessage.updateMany({
      where: { id: messageId, recipientId: accountId, readAt: null },
      data: { readAt: new Date(), frozenAt: new Date() },
    });
    if (changed.count === 0) {
      const exists = await this.prisma.inboxMessage.findFirst({
        where: { id: messageId, recipientId: accountId },
        select: { id: true },
      });
      if (!exists)
        throw new NotFoundException({ code: "NOTIFICATION_NOT_FOUND" });
    }
    return { id: messageId, read: true };
  }

  private async queueReminder(
    tx: Prisma.TransactionClient,
    recipientId: string,
    subjectType: "TASK" | "OCCURRENCE",
    subjectId: string,
    reminderKind: "ADVANCE" | "DUE" | "OVERDUE",
    localToday: string,
    localTime: string,
    now: Date,
  ) {
    const scheduledOn = new Date(`${localToday}T00:00:00.000Z`);
    const alreadyQueued = await tx.inboxItem.findFirst({
      where: {
        subjectType,
        subjectId,
        reminderKind,
        scheduledOn,
        message: { recipientId },
      },
      select: { id: true },
    });
    if (alreadyQueued) return 0;
    let slotAt = localSlotUtc(localToday, localTime);
    let message = await tx.inboxMessage.findUnique({
      where: { recipientId_slotAt: { recipientId, slotAt } },
      select: { id: true, slotAt: true, readAt: true, frozenAt: true },
    });
    while (message?.readAt || message?.frozenAt) {
      const nowSlot = Math.floor(now.getTime() / 60_000) * 60_000;
      slotAt = new Date(Math.max(nowSlot, message.slotAt.getTime() + 60_000));
      message = await tx.inboxMessage.findUnique({
        where: { recipientId_slotAt: { recipientId, slotAt } },
        select: { id: true, slotAt: true, readAt: true, frozenAt: true },
      });
    }
    const saved = await tx.inboxMessage.upsert({
      where: { recipientId_slotAt: { recipientId, slotAt } },
      create: { recipientId, slotAt },
      update: {},
      select: { id: true },
    });
    const inserted = await tx.inboxItem.createMany({
      data: [
        {
          messageId: saved.id,
          subjectType,
          subjectId,
          reminderKind,
          scheduledOn,
        },
      ],
      skipDuplicates: true,
    });
    return inserted.count;
  }

  async runReminderCycle(now = new Date()) {
    const localToday = localDateAt(now);
    const localClock = new Date(now.getTime() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(11, 16);
    return this.prisma.$transaction(async (tx) => {
      const [lease] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(1213152580) AS acquired
      `;
      if (!lease?.acquired) return { generated: 0, queued: 0, skipped: true };
      let generated = 0;
      const rules = await tx.recurringRule.findMany({
        where: {
          status: "ACTIVE",
          OR: [
            { familyId: null, manager: { status: "ACTIVE" } },
            { family: { status: "ACTIVE" } },
          ],
        },
        include: { family: { select: { status: true } } },
      });
      for (const rule of rules) {
        if (rule.familyId && rule.family?.status !== "ACTIVE") continue;
        const recipients = rule.familyId
          ? await tx.membership.findMany({
              where: {
                familyId: rule.familyId,
                leftAt: null,
                account: { status: "ACTIVE" },
              },
              select: { accountId: true },
            })
          : [{ accountId: rule.managerId }];
        const preferences = [];
        for (const { accountId } of recipients) {
          preferences.push(
            await tx.reminderPreference.findUnique({
              where: { accountId },
              select: { feeAdvanceDays: true },
            }),
          );
        }
        const advanceDays = Math.max(
          0,
          ...preferences.map((preference) => preference?.feeAdvanceDays ?? 3),
        );
        const effectiveFromOn = dateString(rule.effectiveFromOn);
        let schedule = firstOccurrenceOnOrAfter(
          rule.frequency,
          rule.anchorOn,
          effectiveFromOn,
        );
        const latest = await tx.occurrence.findFirst({
          where: { ruleId: rule.id },
          orderBy: { periodKey: "desc" },
          select: { periodKey: true },
        });
        if (latest && latest.periodKey >= schedule.periodKey) {
          schedule = followingOccurrence(
            rule.frequency,
            rule.anchorOn,
            latest.periodKey,
          );
        }
        const occurrencesToCreate = [];
        for (
          let generatedForRule = 0;
          generatedForRule < 120 &&
          shiftDate(schedule.localDueOn, -advanceDays) <= localToday;
          generatedForRule += 1
        ) {
          occurrencesToCreate.push({
            ruleId: rule.id,
            periodKey: schedule.periodKey,
            dueOn: schedule.dueOn,
            titleSnapshot: rule.title,
            categoryIdSnapshot: rule.categoryId,
            expectedCents: rule.expectedCents,
            managerId: rule.managerId,
            scheduleRevision: rule.scheduleRevision,
          });
          schedule = followingOccurrence(
            rule.frequency,
            rule.anchorOn,
            schedule.periodKey,
          );
        }
        if (occurrencesToCreate.length) {
          const result = await tx.occurrence.createMany({
            data: occurrencesToCreate,
            skipDuplicates: true,
          });
          generated += result.count;
        }
      }

      const tasks = await tx.task.findMany({
        where: { status: "OPEN", deletedAt: null },
        select: { id: true, familyId: true, creatorId: true, dueOn: true },
      });
      let queued = 0;
      for (const task of tasks) {
        const recipients = task.familyId
          ? await tx.membership.findMany({
              where: {
                familyId: task.familyId,
                leftAt: null,
                account: { status: "ACTIVE" },
                family: { status: "ACTIVE" },
              },
              select: { accountId: true },
            })
          : [{ accountId: task.creatorId }];
        for (const { accountId } of recipients) {
          const preference = await tx.reminderPreference.findUnique({
            where: { accountId },
            select: {
              localTime: true,
              taskAdvanceDays: true,
              overdueEnabled: true,
            },
          });
          const localTime = preference?.localTime ?? "09:00";
          if (localClock < localTime) continue;
          const dueOn = dateString(task.dueOn);
          const advanceOn = shiftDate(
            dueOn,
            -(preference?.taskAdvanceDays ?? 1),
          );
          let kind: "ADVANCE" | "DUE" | "OVERDUE" | null = null;
          if (localToday === dueOn) kind = "DUE";
          else if (localToday > dueOn && (preference?.overdueEnabled ?? true))
            kind = "OVERDUE";
          else if (localToday === advanceOn) kind = "ADVANCE";
          if (!kind) continue;
          queued += await this.queueReminder(
            tx,
            accountId,
            "TASK",
            task.id,
            kind,
            localToday,
            localTime,
            now,
          );
        }
      }

      const occurrences = await tx.occurrence.findMany({
        where: { status: "PENDING" },
        include: { rule: { select: { familyId: true, managerId: true } } },
      });
      for (const occurrence of occurrences) {
        const recipients = occurrence.rule.familyId
          ? await tx.membership.findMany({
              where: {
                familyId: occurrence.rule.familyId,
                leftAt: null,
                account: { status: "ACTIVE" },
                family: { status: "ACTIVE" },
              },
              select: { accountId: true },
            })
          : [{ accountId: occurrence.rule.managerId }];
        for (const { accountId } of recipients) {
          const preference = await tx.reminderPreference.findUnique({
            where: { accountId },
            select: {
              localTime: true,
              feeAdvanceDays: true,
              overdueEnabled: true,
            },
          });
          const localTime = preference?.localTime ?? "09:00";
          if (localClock < localTime) continue;
          const dueOn = dateString(occurrence.dueOn);
          const advanceOn = shiftDate(
            dueOn,
            -(preference?.feeAdvanceDays ?? 3),
          );
          let kind: "ADVANCE" | "DUE" | "OVERDUE" | null = null;
          if (localToday === dueOn) kind = "DUE";
          else if (localToday > dueOn && (preference?.overdueEnabled ?? true))
            kind = "OVERDUE";
          else if (localToday === advanceOn) kind = "ADVANCE";
          if (!kind) continue;
          queued += await this.queueReminder(
            tx,
            accountId,
            "OCCURRENCE",
            occurrence.id,
            kind,
            localToday,
            localTime,
            now,
          );
        }
      }
      return { generated, queued };
    });
  }
}
