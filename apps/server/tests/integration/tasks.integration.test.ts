import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "../../prisma/generated/client/client.js";
import { expenseCategories } from "@homedata/contracts";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { FamiliesService } from "../../src/modules/families/families.service.js";
import { LedgerService } from "../../src/modules/ledger/ledger.service.js";
import type { ReceiptStorageService } from "../../src/modules/ledger/receipt-storage.service.js";
import type { PrismaService } from "../../src/shared/database/prisma.service.js";

const databaseUrl = "postgresql://homedata:test@127.0.0.1:55435/homedata";
let database: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;
let prisma: PrismaClient | undefined;
let tasks: TasksService;
let families: FamiliesService;
let ledger: LedgerService;
let adminId = "";
let memberId = "";
let familyId = "";
let categoryId = "";

describe("tasks, recurring fees, and inbox reminders", () => {
  beforeAll(async () => {
    database = new PGlite();
    await database.waitReady;
    socketServer = new PGLiteSocketServer({
      db: database,
      host: "127.0.0.1",
      port: 55435,
    });
    await socketServer.start();
    for (const migration of [
      "20261015000000_init/migration.sql",
      "20261015010000_identity/migration.sql",
      "20261015010100_family_default_city/migration.sql",
      "20261015020000_ledger/migration.sql",
      "20261015030000_tasks_recurring/migration.sql",
      "20261015040000_recurring_effective_period/migration.sql",
    ]) {
      await database.exec(
        await readFile(
          resolve(process.cwd(), "prisma/migrations", migration),
          "utf8",
        ),
      );
    }
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    const admin = await prisma.account.create({
      data: {
        username: "task-admin",
        usernameNormalized: "task-admin",
        nickname: "家长",
        passwordHash: "test-only",
        mustChangePassword: false,
      },
    });
    const member = await prisma.account.create({
      data: {
        username: "task-member",
        usernameNormalized: "task-member",
        nickname: "家庭成员",
        passwordHash: "test-only",
        mustChangePassword: false,
      },
    });
    adminId = admin.id;
    memberId = member.id;
    const family = await prisma.family.create({
      data: {
        name: "待办测试家庭",
        adminAccountId: adminId,
        memberships: {
          create: [{ accountId: adminId }, { accountId: memberId }],
        },
      },
    });
    familyId = family.id;
    categoryId = (
      await prisma.category.create({
        data: { ...expenseCategories[3], sortOrder: 1 },
      })
    ).id;
    const client = prisma as unknown as PrismaService;
    tasks = new TasksService(client);
    families = new FamiliesService(client);
    ledger = new LedgerService(client, {} as ReceiptStorageService);
  }, 30_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await socketServer?.stop();
    await database?.close();
  });

  it("reminds every current family member, records completion, and transfers management on removal", async () => {
    const task = await tasks.createTask(memberId, {
      title: "缴纳水费",
      dueOn: "2026-10-18",
      familyId,
    });
    const handoverTask = await tasks.createTask(memberId, {
      title: "登记燃气表读数",
      dueOn: "2026-10-25",
      familyId,
    });
    const rule = await tasks.createRecurring(memberId, {
      title: "每月水费",
      categoryId,
      frequency: "MONTHLY",
      anchorOn: "2026-10-20",
      expectedAmount: "80.00",
      familyId,
    });

    const cycle = await tasks.runReminderCycle(
      new Date("2026-10-17T01:00:00.000Z"),
    );
    expect(cycle.generated).toBe(1);
    expect(cycle.queued).toBe(4);
    const adminMessages = await tasks.listNotifications(adminId);
    const memberMessages = await tasks.listNotifications(memberId);
    expect(adminMessages.items[0]?.items).toHaveLength(2);
    expect(memberMessages.items[0]?.items).toHaveLength(2);

    await tasks.markNotificationRead(adminMessages.items[0]!.id, adminId);
    await tasks.createTask(memberId, {
      title: "确认物业缴费",
      dueOn: "2026-10-18",
      familyId,
    });
    const laterCycle = await tasks.runReminderCycle(
      new Date("2026-10-17T01:00:00.000Z"),
    );
    expect(laterCycle.queued).toBe(2);
    const refreshedAdminMessages = await tasks.listNotifications(adminId);
    expect(refreshedAdminMessages.items).toHaveLength(2);
    expect(refreshedAdminMessages.items[0]?.items).toHaveLength(1);
    expect(refreshedAdminMessages.items[1]?.items).toHaveLength(2);

    const occurrence = (await tasks.listOccurrences(rule.id, memberId))
      .items[0]!;
    const payment = await tasks.payOccurrence(
      occurrence.id,
      memberId,
      {
        amount: "83.50",
        occurredOn: "2026-10-20",
        version: occurrence.version,
      },
      randomUUID(),
    );
    let expense = await prisma!.expense.findUniqueOrThrow({
      where: { id: payment.expenseId },
    });
    await ledger.remove(expense.id, memberId, expense.version);
    let occurrenceRow = await prisma!.occurrence.findUniqueOrThrow({
      where: { id: occurrence.id },
    });
    expect(occurrenceRow.status).toBe("PENDING");
    expense = await prisma!.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    await ledger.restoreExpense(expense.id, memberId, expense.version);
    occurrenceRow = await prisma!.occurrence.findUniqueOrThrow({
      where: { id: occurrence.id },
    });
    expect(occurrenceRow.status).toBe("PAID");
    expense = await prisma!.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    await ledger.remove(expense.id, memberId, expense.version);
    occurrenceRow = await prisma!.occurrence.findUniqueOrThrow({
      where: { id: occurrence.id },
    });
    const skipped = await tasks.skipOccurrence(
      occurrence.id,
      memberId,
      occurrenceRow.version,
    );
    expect(skipped.status).toBe("SKIPPED");
    expense = await prisma!.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    await expect(
      ledger.restoreExpense(expense.id, memberId, expense.version),
    ).rejects.toMatchObject({
      response: { code: "PERIOD_SKIPPED" },
    });

    const completed = await tasks.completeTask(task.id, adminId, task.version);
    expect(completed.status).toBe("DONE");
    const preference = await tasks.updateReminderPreference(memberId, {
      localTime: "08:15",
      taskAdvanceDays: 0,
      feeAdvanceDays: 2,
      overdueEnabled: false,
    });
    expect(preference.localTime).toBe("08:15");

    await families.removeMember(familyId, adminId, memberId, 1);
    const transferred = await prisma!.task.findUniqueOrThrow({
      where: { id: handoverTask.id },
    });
    expect(transferred.managerId).toBe(adminId);
    const managedRule = await prisma!.recurringRule.findUniqueOrThrow({
      where: { id: rule.id },
    });
    expect(managedRule.managerId).toBe(adminId);
    await expect(tasks.getTask(task.id, memberId)).rejects.toMatchObject({
      response: { code: "TASK_NOT_FOUND" },
    });
  });

  it("keeps notification reads private to the intended recipient", async () => {
    const message = await prisma!.inboxMessage.create({
      data: {
        recipientId: adminId,
        slotAt: new Date("2026-10-17T02:00:00.000Z"),
      },
    });
    await expect(
      tasks.markNotificationRead(message.id, memberId),
    ).rejects.toMatchObject({
      response: { code: "NOTIFICATION_NOT_FOUND" },
    });
    await expect(
      tasks.markNotificationRead(message.id, adminId),
    ).resolves.toMatchObject({ read: true });
    const frozen = await prisma!.inboxMessage.findUniqueOrThrow({
      where: { id: message.id },
    });
    expect(frozen.readAt).not.toBeNull();
    expect(frozen.frozenAt).not.toBeNull();
  });

  it("skips a paused month and resumes at the next cycle", async () => {
    const rule = await tasks.createRecurring(adminId, {
      title: "暂停恢复测试费用",
      categoryId,
      frequency: "MONTHLY",
      anchorOn: "2026-10-20",
      familyId,
    });
    const paused = await tasks.setRecurringStatus(
      rule.id,
      adminId,
      rule.version,
      "PAUSED",
    );
    const resumed = await tasks.setRecurringStatus(
      rule.id,
      adminId,
      paused.version,
      "ACTIVE",
    );

    await tasks.runReminderCycle(new Date("2026-11-22T01:00:00.000Z"));
    const occurrences = await prisma!.occurrence.findMany({
      where: { ruleId: rule.id },
      orderBy: { periodKey: "asc" },
    });
    expect(resumed.status).toBe("ACTIVE");
    expect(occurrences.map(({ periodKey }) => periodKey)).toEqual(["2026-11"]);
  });

  it("reconstructs every active monthly occurrence missed while the worker was down", async () => {
    const rule = await tasks.createRecurring(adminId, {
      title: "停机补建测试费用",
      categoryId,
      frequency: "MONTHLY",
      anchorOn: "2026-10-20",
      familyId,
    });

    const firstScan = await tasks.runReminderCycle(
      new Date("2026-10-20T01:00:00.000Z"),
    );
    const recoveredScan = await tasks.runReminderCycle(
      new Date("2026-12-20T01:00:00.000Z"),
    );
    const occurrences = await prisma!.occurrence.findMany({
      where: { ruleId: rule.id },
      orderBy: { periodKey: "asc" },
    });
    expect(firstScan.generated).toBe(1);
    expect(recoveredScan.generated).toBeGreaterThanOrEqual(2);
    expect(occurrences.map(({ periodKey }) => periodKey)).toEqual([
      "2026-10",
      "2026-11",
      "2026-12",
    ]);
  });
});
