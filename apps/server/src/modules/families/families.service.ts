import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../../../prisma/generated/client/client.js";
import { PrismaService } from "../../shared/database/prisma.service.js";
import { normalizeUsername } from "../auth/auth.service.js";

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

@Injectable()
export class FamiliesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async loadFamily(familyId: string) {
    return this.prisma.family.findUnique({
      where: { id: familyId },
      include: {
        memberships: {
          where: { leftAt: null, account: { status: "ACTIVE" } },
          include: { account: true },
          orderBy: { joinedAt: "asc" },
        },
      },
    });
  }

  private summary(
    family: NonNullable<Awaited<ReturnType<FamiliesService["loadFamily"]>>>,
    accountId: string,
  ) {
    return {
      id: family.id,
      name: family.name,
      adminAccountId: family.adminAccountId,
      status: family.status,
      version: family.version,
      defaultCity: family.defaultCityName
        ? {
            name: family.defaultCityName,
            countryCode: family.defaultCityCountry!,
            latitude: family.defaultCityLatitude!,
            longitude: family.defaultCityLongitude!,
            timezone: family.defaultCityTimezone!,
          }
        : null,
      role: family.adminAccountId === accountId ? "ADMIN" : "MEMBER",
      members: family.memberships.map(({ account }) => ({
        id: account.id,
        username: account.username,
        nickname: account.nickname,
      })),
    };
  }

  async current(accountId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { accountId, leftAt: null },
      select: { familyId: true },
    });
    if (!membership) return null;
    const family = await this.loadFamily(membership.familyId);
    return family ? this.summary(family, accountId) : null;
  }

  async setDefaultCity(
    familyId: string,
    accountId: string,
    input: {
      version: number;
      city: {
        name: string;
        countryCode: string;
        latitude: number;
        longitude: number;
        timezone: string;
      } | null;
    },
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE families SET version = version WHERE id = ${familyId}::uuid`;
      const family = await tx.family.findUnique({ where: { id: familyId } });
      if (!family || family.status !== "ACTIVE") {
        throw new NotFoundException({ code: "FAMILY_NOT_FOUND" });
      }
      const membership = await tx.membership.findFirst({
        where: {
          familyId,
          accountId,
          leftAt: null,
          account: { status: "ACTIVE" },
        },
        select: { id: true },
      });
      if (!membership)
        throw new NotFoundException({ code: "FAMILY_NOT_FOUND" });
      if (family.version !== input.version) {
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      }
      const city = input.city;
      await tx.family.update({
        where: { id: familyId },
        data: {
          defaultCityName: city?.name ?? null,
          defaultCityCountry: city?.countryCode ?? null,
          defaultCityLatitude: city?.latitude ?? null,
          defaultCityLongitude: city?.longitude ?? null,
          defaultCityTimezone: city?.timezone ?? null,
          version: { increment: 1 },
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "FAMILY_DEFAULT_CITY_UPDATED",
          subjectType: "FAMILY",
          subjectId: familyId,
          details: { city: city?.name ?? null },
        },
      });
    });
    return this.current(accountId);
  }

  async create(accountId: string, name: string) {
    try {
      const family = await this.prisma.$transaction(async (tx) => {
        const account = await tx.account.findUnique({
          where: { id: accountId },
        });
        if (!account || account.status !== "ACTIVE") {
          throw new ForbiddenException({ code: "ACCOUNT_NOT_ACTIVE" });
        }
        const existing = await tx.membership.findFirst({
          where: { accountId, leftAt: null },
        });
        if (existing)
          throw new ConflictException({ code: "ALREADY_IN_FAMILY" });
        const created = await tx.family.create({
          data: {
            name,
            adminAccountId: accountId,
            memberships: { create: { accountId } },
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: accountId,
            action: "FAMILY_CREATED",
            subjectType: "FAMILY",
            subjectId: created.id,
          },
        });
        return created;
      });
      return this.summary((await this.loadFamily(family.id))!, accountId);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: "ALREADY_IN_FAMILY" });
      }
      throw error;
    }
  }

  private async requireMember(familyId: string, accountId: string) {
    const family = await this.loadFamily(familyId);
    const membership = await this.prisma.membership.findFirst({
      where: { familyId, accountId, leftAt: null },
    });
    if (!family || !membership) {
      throw new NotFoundException({ code: "FAMILY_NOT_FOUND" });
    }
    return family;
  }

  private async requireAdmin(familyId: string, accountId: string) {
    const family = await this.requireMember(familyId, accountId);
    if (family.adminAccountId !== accountId) {
      throw new ForbiddenException({ code: "FAMILY_ADMIN_REQUIRED" });
    }
    return family;
  }

  private async transferOpenWork(
    tx: Prisma.TransactionClient,
    familyId: string,
    fromAccountId: string,
    toAccountId: string,
    actorId: string,
  ) {
    const target = await tx.membership.findFirst({
      where: {
        familyId,
        accountId: toAccountId,
        leftAt: null,
        account: { status: "ACTIVE" },
      },
      select: { id: true },
    });
    if (!target)
      throw new ConflictException({ code: "TASK_HANDOVER_TARGET_UNAVAILABLE" });
    await tx.task.updateMany({
      where: {
        familyId,
        managerId: fromAccountId,
        status: "OPEN",
        deletedAt: null,
      },
      data: {
        managerId: toAccountId,
        managerMembershipId: target.id,
        version: { increment: 1 },
      },
    });
    await tx.task.updateMany({
      where: {
        familyId,
        assigneeId: fromAccountId,
        status: "OPEN",
        deletedAt: null,
      },
      data: { assigneeId: null, version: { increment: 1 } },
    });
    const rules = await tx.recurringRule.findMany({
      where: { familyId, managerId: fromAccountId },
      select: { id: true },
    });
    await tx.recurringRule.updateMany({
      where: { familyId, managerId: fromAccountId },
      data: {
        managerId: toAccountId,
        managerMembershipId: target.id,
        version: { increment: 1 },
      },
    });
    for (const rule of rules) {
      await tx.occurrence.updateMany({
        where: { ruleId: rule.id, status: "PENDING", managerId: fromAccountId },
        data: { managerId: toAccountId, version: { increment: 1 } },
      });
    }
    await tx.auditEvent.create({
      data: {
        actorId,
        action: "FAMILY_OPEN_WORK_TRANSFERRED",
        subjectType: "FAMILY",
        subjectId: familyId,
        details: { fromAccountId, toAccountId },
      },
    });
  }

  async members(familyId: string, accountId: string) {
    const family = await this.requireMember(familyId, accountId);
    return this.summary(family, accountId);
  }

  async addMember(familyId: string, accountId: string, username: string) {
    const family = await this.requireAdmin(familyId, accountId);
    if (family.status !== "ACTIVE") {
      throw new ConflictException({ code: "FAMILY_ARCHIVED" });
    }
    const normalized = normalizeUsername(username);
    const target = await this.prisma.account.findUnique({
      where: { usernameNormalized: normalized },
    });
    if (!target || target.status !== "ACTIVE") {
      throw new NotFoundException({ code: "FAMILY_ACCOUNT_UNAVAILABLE" });
    }
    if (target.id === accountId) {
      throw new ConflictException({ code: "ALREADY_IN_FAMILY" });
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.family.updateMany({
          where: {
            id: familyId,
            adminAccountId: accountId,
            status: "ACTIVE",
            version: family.version,
          },
          data: { version: { increment: 1 } },
        });
        if (changed.count !== 1) {
          throw new ConflictException({ code: "VERSION_CONFLICT" });
        }
        const existing = await tx.membership.findFirst({
          where: { accountId: target.id, leftAt: null },
        });
        if (existing)
          throw new ConflictException({ code: "ACCOUNT_ALREADY_IN_FAMILY" });
        await tx.membership.create({
          data: { familyId, accountId: target.id },
        });
        await tx.auditEvent.create({
          data: {
            actorId: accountId,
            action: "FAMILY_MEMBER_ADDED",
            subjectType: "ACCOUNT",
            subjectId: target.id,
            details: { familyId },
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: "ACCOUNT_ALREADY_IN_FAMILY" });
      }
      throw error;
    }
    return this.members(familyId, accountId);
  }

  async removeMember(
    familyId: string,
    actorId: string,
    targetId: string,
    version: number,
  ) {
    const family = await this.requireAdmin(familyId, actorId);
    if (family.status !== "ACTIVE") {
      throw new ConflictException({ code: "FAMILY_ARCHIVED" });
    }
    if (family.version !== version) {
      throw new ConflictException({ code: "VERSION_CONFLICT" });
    }
    if (family.adminAccountId === targetId) {
      throw new ConflictException({ code: "FAMILY_ADMIN_HANDOVER_REQUIRED" });
    }
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.membership.findFirst({
        where: { familyId, accountId: targetId, leftAt: null },
      });
      if (!current)
        throw new NotFoundException({ code: "FAMILY_MEMBER_NOT_FOUND" });
      const changed = await tx.family.updateMany({
        where: {
          id: familyId,
          adminAccountId: actorId,
          status: "ACTIVE",
          version,
        },
        data: { version: { increment: 1 } },
      });
      if (changed.count !== 1) {
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      }
      const familyAdminMembership = await tx.membership.findFirst({
        where: { familyId, accountId: actorId, leftAt: null },
        select: { id: true },
      });
      if (!familyAdminMembership)
        throw new ConflictException({ code: "FAMILY_ADMIN_REQUIRED" });
      await this.transferOpenWork(tx, familyId, targetId, actorId, actorId);
      await tx.membership.update({
        where: { id: current.id },
        data: { leftAt: new Date(), leaveReason: "ADMIN_REMOVED" },
      });
      await tx.auditEvent.create({
        data: {
          actorId,
          action: "FAMILY_MEMBER_REMOVED",
          subjectType: "ACCOUNT",
          subjectId: targetId,
          details: { familyId },
        },
      });
    });
    return this.members(familyId, actorId);
  }

  async leave(familyId: string, accountId: string, version: number) {
    const family = await this.requireMember(familyId, accountId);
    if (family.status !== "ACTIVE") {
      throw new ConflictException({ code: "FAMILY_ARCHIVED" });
    }
    if (family.version !== version) {
      throw new ConflictException({ code: "VERSION_CONFLICT" });
    }
    if (family.adminAccountId === accountId) {
      throw new ConflictException({ code: "FAMILY_ADMIN_HANDOVER_REQUIRED" });
    }
    await this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { familyId, accountId, leftAt: null },
      });
      if (!membership)
        throw new NotFoundException({ code: "FAMILY_MEMBER_NOT_FOUND" });
      const changed = await tx.family.updateMany({
        where: { id: familyId, version },
        data: { version: { increment: 1 } },
      });
      if (changed.count !== 1) {
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      }
      const adminMembership = await tx.membership.findFirst({
        where: { familyId, accountId: family.adminAccountId, leftAt: null },
        select: { id: true },
      });
      if (!adminMembership)
        throw new ConflictException({ code: "FAMILY_ADMIN_REQUIRED" });
      await this.transferOpenWork(
        tx,
        familyId,
        accountId,
        family.adminAccountId,
        accountId,
      );
      await tx.membership.update({
        where: { id: membership.id },
        data: { leftAt: new Date(), leaveReason: "LEFT" },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "FAMILY_MEMBER_LEFT",
          subjectType: "FAMILY",
          subjectId: familyId,
        },
      });
    });
    return { left: true, familyId };
  }

  async handover(
    familyId: string,
    actorId: string,
    targetId: string,
    version: number,
  ) {
    const family = await this.requireAdmin(familyId, actorId);
    if (family.status !== "ACTIVE" || family.version !== version) {
      throw new ConflictException({ code: "VERSION_CONFLICT" });
    }
    const target = await this.prisma.membership.findFirst({
      where: {
        familyId,
        accountId: targetId,
        leftAt: null,
        account: { status: "ACTIVE" },
      },
    });
    if (!target)
      throw new ConflictException({ code: "HANDOVER_TARGET_NOT_MEMBER" });
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.family.updateMany({
        where: {
          id: familyId,
          adminAccountId: actorId,
          version,
          status: "ACTIVE",
        },
        data: { adminAccountId: targetId, version: { increment: 1 } },
      });
      if (changed.count !== 1) {
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      }
      await tx.auditEvent.create({
        data: {
          actorId,
          action: "FAMILY_ADMIN_HANDED_OVER",
          subjectType: "FAMILY",
          subjectId: familyId,
          details: { newAdminAccountId: targetId },
        },
      });
    });
    return this.members(familyId, actorId);
  }

  async setArchived(
    familyId: string,
    actorId: string,
    version: number,
    archived: boolean,
  ) {
    const family = await this.requireAdmin(familyId, actorId);
    const expectedStatus = archived ? "ACTIVE" : "ARCHIVED";
    if (family.version !== version || family.status !== expectedStatus) {
      throw new ConflictException({ code: "VERSION_CONFLICT" });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.family.updateMany({
        where: {
          id: familyId,
          adminAccountId: actorId,
          version,
          status: expectedStatus,
        },
        data: {
          status: archived ? "ARCHIVED" : "ACTIVE",
          archivedAt: archived ? new Date() : null,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      }
      const result = await tx.family.findUniqueOrThrow({
        where: { id: familyId },
      });
      await tx.auditEvent.create({
        data: {
          actorId,
          action: archived ? "FAMILY_ARCHIVED" : "FAMILY_RESTORED",
          subjectType: "FAMILY",
          subjectId: familyId,
        },
      });
      return result;
    });
    return this.summary((await this.loadFamily(updated.id))!, actorId);
  }
}
