import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "../../prisma/generated/client/client.js";
import { expenseCategories } from "@homedata/contracts";
import { ReportsService } from "../../src/modules/reports/reports.service.js";
import { SharesService } from "../../src/modules/shares/shares.service.js";
import type { PrismaService } from "../../src/shared/database/prisma.service.js";

const databaseUrl = "postgresql://homedata:test@127.0.0.1:55436/homedata";
let database: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;
let prisma: PrismaClient | undefined;
let shares: SharesService;
let ownerId = "";
let memberId = "";
let familyId = "";
let categoryId = "";

const shareInput = {
  space: "personal" as const,
  origin: "all" as const,
  from: "2026-10-01",
  to: "2026-10-31",
  period: "month" as const,
  expiresInDays: 7 as const,
};

describe("public aggregate shares", () => {
  beforeAll(async () => {
    database = new PGlite();
    await database.waitReady;
    socketServer = new PGLiteSocketServer({
      db: database,
      host: "127.0.0.1",
      port: 55436,
    });
    await socketServer.start();
    for (const migration of [
      "20261015000000_init/migration.sql",
      "20261015010000_identity/migration.sql",
      "20261015010100_family_default_city/migration.sql",
      "20261015020000_ledger/migration.sql",
      "20261015030000_tasks_recurring/migration.sql",
      "20261015040000_recurring_effective_period/migration.sql",
      "20261015050000_share_snapshots/migration.sql",
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
    const owner = await prisma.account.create({
      data: {
        username: "share-owner",
        usernameNormalized: "share-owner",
        nickname: "记录人",
        passwordHash: "test-only",
        mustChangePassword: false,
      },
    });
    const member = await prisma.account.create({
      data: {
        username: "share-member",
        usernameNormalized: "share-member",
        nickname: "家庭成员隐私名",
        passwordHash: "test-only",
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;
    memberId = member.id;
    familyId = (
      await prisma.family.create({
        data: {
          name: "分享测试家庭",
          adminAccountId: ownerId,
          memberships: {
            create: [{ accountId: ownerId }, { accountId: memberId }],
          },
        },
      })
    ).id;
    categoryId = (
      await prisma.category.create({
        data: { ...expenseCategories[3]!, sortOrder: 1 },
      })
    ).id;
    await prisma.expense.create({
      data: {
        payerId: ownerId,
        familyId,
        categoryId,
        title: "不应出现在分享里的明细标题",
        occurredOn: new Date("2026-10-12T00:00:00.000Z"),
        amountCents: 1299n,
      },
    });
    const client = prisma as unknown as PrismaService;
    shares = new SharesService(client, new ReportsService(client));
  }, 30_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await socketServer?.stop();
    await database?.close();
  });

  it("stores only the token digest and publishes aggregate-only static data", async () => {
    const created = await shares.create(ownerId, shareInput);
    const stored = await prisma!.shareSnapshot.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.tokenHash).toBe(
      createHash("sha256").update(created.token).digest("hex"),
    );
    expect(stored.tokenHash).not.toContain(created.token);
    const result = await shares.publicView(created.token);
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("share unavailable");
    expect(result.payload).toMatchObject({ summary: { expense: "12.99" } });
    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain("不应出现在分享里的明细标题");
    expect(serialized).not.toContain("家庭成员隐私名");
  });

  it("requires a passcode, grants a short independent session, and revokes access", async () => {
    const created = await shares.create(ownerId, {
      ...shareInput,
      passcode: "family9",
    });
    expect(await shares.publicView(created.token)).toEqual({
      status: "locked",
    });
    await expect(
      shares.unlock(created.token, "wrongpass", "127.0.0.1"),
    ).rejects.toMatchObject({ response: { code: "SHARE_UNLOCK_INVALID" } });
    const session = await shares.unlock(created.token, "family9", "127.0.0.1");
    expect(
      (await shares.publicView(created.token, session.rawToken)).status,
    ).toBe("available");
    const stored = await prisma!.shareSnapshot.findUniqueOrThrow({
      where: { id: created.id },
      select: { version: true },
    });
    await shares.revoke(created.id, ownerId, stored.version);
    expect(await shares.publicView(created.token, session.rawToken)).toEqual({
      status: "unavailable",
    });
  });

  it("allows family snapshots only for administrators and invalidates on membership loss", async () => {
    const input = {
      ...shareInput,
      space: "family" as const,
      familyId,
    };
    const created = await shares.create(ownerId, input);
    await expect(shares.create(memberId, input)).rejects.toMatchObject({
      response: { code: "FAMILY_ADMIN_REQUIRED" },
    });
    expect((await shares.publicView(created.token)).status).toBe("available");
    await prisma!.membership.updateMany({
      where: { familyId, accountId: ownerId, leftAt: null },
      data: { leftAt: new Date() },
    });
    expect(await shares.publicView(created.token)).toEqual({
      status: "unavailable",
    });
    const stored = await prisma!.shareSnapshot.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.invalidatedAt).not.toBeNull();
  });
});
