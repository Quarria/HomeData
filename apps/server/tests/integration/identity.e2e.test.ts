import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import { PrismaPg } from "@prisma/adapter-pg";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "../../prisma/generated/client/client.js";
import { hashPassword } from "../../src/shared/auth/password.js";
import { AppModule } from "../../src/modules/app.module.js";
import { AppLogger } from "../../src/shared/logging/app-logger.js";
import { ApiExceptionFilter } from "../../src/shared/http/api-exception.filter.js";
import { expenseCategories } from "@homedata/contracts";

const databaseUrl = "postgresql://homedata:test@127.0.0.1:55434/homedata";
const previousEnvironment = {
  nodeEnv: process.env.NODE_ENV,
  databaseUrl: process.env.DATABASE_URL,
  appOrigin: process.env.APP_ORIGIN,
  receiptStoragePath: process.env.RECEIPT_STORAGE_PATH,
};
let database: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;
let prisma: PrismaClient | undefined;
let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
let baseUrl = "";
let memberAccountId = "";
let categoryId = "";
let csrfCookie = "";
let csrfToken = "";
let receiptDirectory = "";

function cookiePair(response: Response, name: string) {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Expected ${name} cookie.`);
  return cookie.split(";", 1)[0]!;
}

async function api(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function post(path: string, body: unknown, cookies: string[]) {
  return api(path, {
    method: "POST",
    headers: {
      origin: "http://localhost:5173",
      cookie: [...cookies, csrfCookie].join("; "),
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify(body),
  });
}

describe("account, family, and ledger flows", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = databaseUrl;
    process.env.APP_ORIGIN = "http://localhost:5173";
    receiptDirectory = await mkdtemp(join(tmpdir(), "homedata-receipts-"));
    process.env.RECEIPT_STORAGE_PATH = receiptDirectory;
    database = new PGlite();
    await database.waitReady;
    socketServer = new PGLiteSocketServer({
      db: database,
      host: "127.0.0.1",
      port: 55434,
    });
    await socketServer.start();

    for (const migration of [
      "20261015000000_init/migration.sql",
      "20261015010000_identity/migration.sql",
      "20261015010100_family_default_city/migration.sql",
      "20261015020000_ledger/migration.sql",
      "20261015030000_tasks_recurring/migration.sql",
    ]) {
      const sql = await readFile(
        resolve(process.cwd(), "prisma/migrations", migration),
        "utf8",
      );
      await database.exec(sql);
    }

    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    await prisma.account.create({
      data: {
        username: "admin",
        usernameNormalized: "admin",
        nickname: "系统管理员",
        passwordHash: await hashPassword("InitialPassword!234"),
        systemRole: "SYSTEM_ADMIN",
        mustChangePassword: true,
      },
    });
    const memberAccount = await prisma.account.create({
      data: {
        username: "member",
        usernameNormalized: "member",
        nickname: "家庭成员",
        passwordHash: await hashPassword("MemberPassword!234"),
        mustChangePassword: true,
      },
    });
    memberAccountId = memberAccount.id;
    const category = await prisma.category.create({
      data: { ...expenseCategories[0], sortOrder: 1 },
    });
    categoryId = category.id;
    await prisma.$disconnect();

    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new ApiExceptionFilter());
    app.useLogger(app.get(AppLogger));
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();

    const csrfResponse = await api("/auth/csrf");
    csrfCookie = cookiePair(csrfResponse, "hd_csrf");
    csrfToken = (await csrfResponse.json()).data.token as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await socketServer?.stop();
    await database?.close();
    if (receiptDirectory)
      await rm(receiptDirectory, { recursive: true, force: true });
    if (previousEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment.nodeEnv;
    if (previousEnvironment.databaseUrl === undefined)
      delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousEnvironment.databaseUrl;
    if (previousEnvironment.appOrigin === undefined)
      delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousEnvironment.appOrigin;
    if (previousEnvironment.receiptStoragePath === undefined)
      delete process.env.RECEIPT_STORAGE_PATH;
    else
      process.env.RECEIPT_STORAGE_PATH = previousEnvironment.receiptStoragePath;
  });

  it("forces a password change, rotates the session, and enforces family roles", async () => {
    const login = await post(
      "/auth/login",
      { username: "ADMIN", password: "InitialPassword!234" },
      [],
    );
    expect(login.status, await login.clone().text()).toBe(201);
    const loginBody = (await login.json()) as {
      data: { account: { id: string }; mustChangePassword: boolean };
    };
    expect(loginBody.data.mustChangePassword).toBe(true);
    const oldSession = cookiePair(login, "hd_session");

    const profileBeforeChange = await api("/me", {
      headers: { cookie: oldSession },
    });
    expect(profileBeforeChange.status).toBe(200);
    const blocked = await api("/admin/accounts", {
      headers: { cookie: oldSession },
    });
    expect(blocked.status).toBe(403);

    const changed = await post(
      "/me/password",
      {
        currentPassword: "InitialPassword!234",
        newPassword: "ChangedPassword!456",
      },
      [oldSession],
    );
    expect(changed.status).toBe(201);
    const newSession = cookiePair(changed, "hd_session");
    expect(newSession).not.toBe(oldSession);
    expect((await api("/me", { headers: { cookie: oldSession } })).status).toBe(
      401,
    );
    const formerAdminProfile = await api("/me", {
      headers: { cookie: newSession },
    });
    expect(formerAdminProfile.status).toBe(200);
    expect((await formerAdminProfile.json()).data.family).toBeNull();

    const currentProfile = await api("/me", {
      headers: { cookie: newSession },
    });
    const profileAccount = (await currentProfile.json()).data.account as {
      version: number;
    };
    const renamed = await api("/me", {
      method: "PATCH",
      headers: {
        origin: "http://localhost:5173",
        cookie: `${newSession}; ${csrfCookie}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        nickname: "管理员新昵称",
        version: profileAccount.version,
      }),
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).data.nickname).toBe("管理员新昵称");

    const createdAccount = await post(
      "/admin/accounts",
      {
        username: "member2",
        nickname: "第二位成员",
        initialPassword: "MemberTwoPassword!234",
      },
      [newSession],
    );
    expect(createdAccount.status).toBe(201);
    const secondMemberId = (
      (await createdAccount.json()).data as { id: string }
    ).id;

    const familyResponse = await post("/families", { name: "测试家庭" }, [
      newSession,
    ]);
    expect(familyResponse.status).toBe(201);
    const family = (await familyResponse.json()).data as {
      id: string;
      version: number;
      members: Array<{ id: string }>;
    };
    const added = await post(
      `/families/${family.id}/members`,
      { username: "member" },
      [newSession],
    );
    expect(added.status).toBe(201);
    const familyAfterAdd = (await added.json()).data as {
      version: number;
      members: Array<{ id: string }>;
    };
    expect(familyAfterAdd.members).toHaveLength(2);

    const addedSecond = await post(
      `/families/${family.id}/members`,
      { username: "member2" },
      [newSession],
    );
    expect(addedSecond.status).toBe(201);
    const familyWithThree = (await addedSecond.json()).data as {
      version: number;
      members: Array<{ id: string }>;
    };
    expect(familyWithThree.members).toHaveLength(3);
    const removedSecond = await api(
      `/families/${family.id}/members/${secondMemberId}`,
      {
        method: "DELETE",
        headers: {
          origin: "http://localhost:5173",
          cookie: `${newSession}; ${csrfCookie}`,
          "x-csrf-token": csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: familyWithThree.version }),
      },
    );
    expect(removedSecond.status).toBe(200);
    const familyAfterRemove = (await removedSecond.json()).data as {
      version: number;
    };

    const defaultCity = {
      name: "杭州市 · 浙江 · 中国",
      countryCode: "CN",
      latitude: 30.27,
      longitude: 120.15,
      timezone: "Asia/Shanghai",
    };
    const savedCity = await api(`/families/${family.id}/default-city`, {
      method: "PATCH",
      headers: {
        origin: "http://localhost:5173",
        cookie: `${newSession}; ${csrfCookie}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: familyAfterRemove.version,
        city: defaultCity,
      }),
    });
    expect(savedCity.status).toBe(200);
    const profileAfterCitySave = await api("/me", {
      headers: { cookie: newSession },
    });
    expect((await profileAfterCitySave.json()).data.family.defaultCity).toEqual(
      defaultCity,
    );

    const secondFamily = await post("/families", { name: "不能重复加入" }, [
      newSession,
    ]);
    expect(secondFamily.status).toBe(409);

    const handover = await post(
      `/families/${family.id}/handover`,
      {
        targetAccountId: memberAccountId,
        version: familyAfterRemove.version + 1,
      },
      [newSession],
    );
    expect(handover.status).toBe(201);
    const handedOver = (await handover.json()).data as {
      role: string;
      version: number;
    };
    expect(handedOver.role).toBe("MEMBER");

    const staleAdmin = await post(
      `/families/${family.id}/archive`,
      { version: handedOver.version },
      [newSession],
    );
    expect(staleAdmin.status).toBe(403);

    const memberLogin = await post(
      "/auth/login",
      { username: "member", password: "MemberPassword!234" },
      [],
    );
    const memberSession = cookiePair(memberLogin, "hd_session");
    const memberPasswordChange = await post(
      "/me/password",
      {
        currentPassword: "MemberPassword!234",
        newPassword: "MemberChanged!456",
      },
      [memberSession],
    );
    const memberSessionAfterChange = cookiePair(
      memberPasswordChange,
      "hd_session",
    );
    const memberCsrfResponse = await api("/auth/csrf");
    const memberCsrfCookie = cookiePair(memberCsrfResponse, "hd_csrf");
    const memberCsrfToken = (await memberCsrfResponse.json()).data
      .token as string;
    const archived = await api(`/families/${family.id}/archive`, {
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        cookie: `${memberSessionAfterChange}; ${memberCsrfCookie}`,
        "x-csrf-token": memberCsrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: handedOver.version }),
    });
    expect(archived.status).toBe(201);
    expect((await archived.json()).data.status).toBe("ARCHIVED");

    const restored = await post(
      `/families/${family.id}/restore`,
      { version: handedOver.version + 1 },
      [memberSessionAfterChange],
    );
    expect(restored.status).toBe(201);
    const restoredFamily = (await restored.json()).data as { version: number };
    const leftFamily = await post(
      `/families/${family.id}/leave`,
      { version: restoredFamily.version },
      [newSession],
    );
    expect(leftFamily.status).toBe(201);
    expect((await api("/me", { headers: { cookie: newSession } })).status).toBe(
      200,
    );

    const secondMemberLogin = await post(
      "/auth/login",
      { username: "member2", password: "MemberTwoPassword!234" },
      [],
    );
    const secondMemberSession = cookiePair(secondMemberLogin, "hd_session");
    const secondMemberPasswordChange = await post(
      "/me/password",
      {
        currentPassword: "MemberTwoPassword!234",
        newPassword: "MemberTwoChanged!456",
      },
      [secondMemberSession],
    );
    const secondMemberActiveSession = cookiePair(
      secondMemberPasswordChange,
      "hd_session",
    );
    const familyB = await post("/families", { name: "另一家庭" }, [
      secondMemberActiveSession,
    ]);
    const familyBId = ((await familyB.json()).data as { id: string }).id;
    const crossFamilyRead = await api(`/families/${familyBId}/members`, {
      headers: { cookie: newSession },
    });
    expect(crossFamilyRead.status).toBe(404);
  });

  it("records expenses and serializes refunds, idempotency, and restore batches", async () => {
    const login = await post(
      "/auth/login",
      { username: "admin", password: "ChangedPassword!456" },
      [],
    );
    const session = cookiePair(login, "hd_session");
    const createKey = randomUUID();
    const expenseInput = {
      title: "本周采购",
      categoryId,
      occurredOn: "2026-10-15",
      amount: "100.00",
    };
    const created = await api("/expenses", {
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        cookie: `${session}; ${csrfCookie}`,
        "x-csrf-token": csrfToken,
        "idempotency-key": createKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(expenseInput),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const expense = (await created.json()).data as {
      id: string;
      version: number;
      amount: string;
    };
    expect(expense.amount).toBe("100.00");
    const initialDetail = await api(`/expenses/${expense.id}`, {
      headers: { cookie: session },
    });
    expect(initialDetail.status, await initialDetail.clone().text()).toBe(200);

    const receiptForm = new FormData();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    receiptForm.set("file", new Blob([png], { type: "image/png" }), "bill.png");
    const uploadResponse = await fetch(`${baseUrl}/api/v1/receipts/uploads`, {
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        cookie: `${session}; ${csrfCookie}`,
        "x-csrf-token": csrfToken,
      },
      body: receiptForm,
    });
    expect(uploadResponse.status, await uploadResponse.clone().text()).toBe(
      201,
    );
    const uploadedReceipt = (await uploadResponse.json()).data as {
      id: string;
    };
    const linkedReceipt = await api(`/expenses/${expense.id}/receipt-links`, {
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        cookie: `${session}; ${csrfCookie}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ receiptId: uploadedReceipt.id }),
    });
    expect(linkedReceipt.status).toBe(201);
    const receiptContent = await api(
      `/receipts/${uploadedReceipt.id}/content`,
      {
        headers: { cookie: session },
      },
    );
    expect(receiptContent.status).toBe(200);
    expect(receiptContent.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await receiptContent.arrayBuffer())).toEqual(png);

    const privateMemberLogin = await post(
      "/auth/login",
      { username: "member", password: "MemberChanged!456" },
      [],
    );
    const privateMemberSession = cookiePair(privateMemberLogin, "hd_session");
    const deniedReceipt = await api(`/receipts/${uploadedReceipt.id}/content`, {
      headers: { cookie: privateMemberSession },
    });
    expect(deniedReceipt.status).toBe(404);

    const replay = await api("/expenses", {
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        cookie: `${session}; ${csrfCookie}`,
        "x-csrf-token": csrfToken,
        "idempotency-key": createKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(expenseInput),
    });
    expect((await replay.json()).data.id).toBe(expense.id);

    const refundRequest = (amount: string, idempotencyKey: string) =>
      api(`/expenses/${expense.id}/refunds`, {
        method: "POST",
        headers: {
          origin: "http://localhost:5173",
          cookie: `${session}; ${csrfCookie}`,
          "x-csrf-token": csrfToken,
          "idempotency-key": idempotencyKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ amount, occurredOn: "2026-10-15" }),
      });
    const refundA = await refundRequest("60.00", randomUUID());
    const refundB = await refundRequest("60.00", randomUUID());
    expect([refundA.status, refundB.status].sort()).toEqual([201, 409]);
    const successfulRefund = (
      await (refundA.status === 201 ? refundA : refundB).json()
    ).data as {
      id: string;
      version: number;
    };

    const repeatedRefundKey = randomUUID();
    const refundableTwenty = await refundRequest("20.00", repeatedRefundKey);
    expect(refundableTwenty.status).toBe(201);
    const refundTwenty = (await refundableTwenty.json()).data as {
      id: string;
      version: number;
    };
    const refundReplay = await refundRequest("20.00", repeatedRefundKey);
    expect((await refundReplay.json()).data.id).toBe(refundTwenty.id);
    const mismatchedReplay = await refundRequest("19.00", repeatedRefundKey);
    expect(mismatchedReplay.status).toBe(409);

    const removedRefund = await api(`/refunds/${refundTwenty.id}`, {
      method: "DELETE",
      headers: {
        origin: "http://localhost:5173",
        cookie: `${session}; ${csrfCookie}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: refundTwenty.version }),
    });
    expect(removedRefund.status).toBe(200);

    const currentExpense = await api(`/expenses/${expense.id}`, {
      headers: { cookie: session },
    });
    const current = (await currentExpense.json()).data as {
      version: number;
      net: string;
    };
    expect(current.net).toBe("40.00");
    const tooSmall = await api(`/expenses/${expense.id}`, {
      method: "PATCH",
      headers: {
        origin: "http://localhost:5173",
        cookie: `${session}; ${csrfCookie}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ amount: "50.00", version: current.version }),
    });
    expect(tooSmall.status).toBe(409);

    const deleted = await api(`/expenses/${expense.id}`, {
      method: "DELETE",
      headers: {
        origin: "http://localhost:5173",
        cookie: `${session}; ${csrfCookie}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: current.version }),
    });
    expect(deleted.status).toBe(200);
    const deletedList = await api("/expenses?space=personal&deleted=true", {
      headers: { cookie: session },
    });
    const deletedBody = (await deletedList.json()).data;
    expect(deletedBody.items).toHaveLength(1);
    const activeList = await api("/expenses?space=personal", {
      headers: { cookie: session },
    });
    expect((await activeList.json()).data.items).toHaveLength(0);

    const deletedExpense = deletedBody.items[0] as { version: number };
    const restored = await api(`/expenses/${expense.id}/restore`, {
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        cookie: `${session}; ${csrfCookie}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: deletedExpense.version }),
    });
    expect(restored.status).toBe(201);
    expect((await restored.json()).data.refund).toBe("60.00");
    expect(successfulRefund.id).toBeTruthy();
  });
});
