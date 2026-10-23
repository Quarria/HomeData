import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

test("shows the approved personal-first navigation on desktop and mobile", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          account: {
            id: "account-demo",
            username: "demo",
            nickname: "演示用户",
            systemRole: "USER",
            status: "ACTIVE",
            mustChangePassword: false,
            version: 1,
          },
          family: null,
          mustChangePassword: false,
        },
        meta: { requestId: "e2e" },
      }),
    }),
  );
  await page.goto("/");
  await expect(page).toHaveTitle(/家常账/);
  await expect(page.getByRole("heading", { name: "个人日常" })).toBeVisible();

  if (page.viewportSize()!.width <= 650) {
    await expect(page.locator(".mobile-current-space")).toHaveText("个人空间");
    await expect(
      page.getByRole("navigation", { name: "手机主导航" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "手机主导航" })
        .getByRole("button", { name: /待办/ }),
    ).toBeVisible();
  } else {
    await expect(page.locator(".breadcrumb")).toContainText("个人空间");
    await expect(
      page.getByRole("navigation", { name: "主导航" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "报表", exact: true }),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("shows login when there is no active session", async ({ page }) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "AUTH_REQUIRED", message: "请登录" },
      }),
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await expect(page.getByRole("button", { name: /登录/ })).toBeVisible();
  const evidence = path.resolve(
    "../../deliverables/paper-notebook/app-evidence",
  );
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: path.join(evidence, `${page.viewportSize()!.width}-login.png`),
    fullPage: true,
  });
});

test("keeps reminder preference fields aligned at the available width", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          account: {
            id: "account-demo",
            username: "demo",
            nickname: "演示用户",
            systemRole: "USER",
            status: "ACTIVE",
            mustChangePassword: false,
            version: 1,
          },
          family: null,
          mustChangePassword: false,
        },
      }),
    }),
  );
  await page.route("**/api/v1/notification-preferences", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          localTime: "09:00",
          taskAdvanceDays: 1,
          feeAdvanceDays: 3,
          overdueEnabled: true,
        },
      }),
    }),
  );

  await page.goto("/");
  const nav =
    page.viewportSize()!.width <= 650
      ? page.locator(".mobile-nav")
      : page.locator(".desktop-nav");
  await nav.getByRole("button", { name: "我的" }).click();

  const fields = page.locator(".reminder-settings .reminder-field");
  await expect(fields).toHaveCount(3);
  for (const field of await fields.all()) {
    const label = await field
      .locator(":scope > span:first-child")
      .boundingBox();
    const input = await field.locator("input").boundingBox();
    expect(label).not.toBeNull();
    expect(input).not.toBeNull();
    expect(Math.abs(input!.y - label!.y - label!.height - 6)).toBeLessThan(1);
  }
  const numberFields = fields.locator(".reminder-input-wrap");
  for (const field of await numberFields.all()) {
    const input = await field.locator("input").boundingBox();
    const unit = await field.locator("small").boundingBox();
    expect(input).not.toBeNull();
    expect(unit).not.toBeNull();
    expect(
      Math.abs(input!.y + input!.height / 2 - unit!.y - unit!.height / 2),
    ).toBeLessThan(1);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("opens a read-only public share without an account session", async ({
  page,
}) => {
  const token = "A".repeat(43);
  const shareUrl = `**/api/v1/public/shares/${token}`;
  let unlocked = false;
  await page.route(shareUrl, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: unlocked
          ? {
              status: "available",
              generatedAt: "2026-10-15T00:00:00.000Z",
              expiresAt: "2026-10-22T00:00:00.000Z",
              payload: {
                summary: {
                  from: "2026-10-01",
                  to: "2026-10-31",
                  scopeLabel: "本人付款，含家庭费用",
                  expense: "46.50",
                  refund: "0.00",
                  net: "46.50",
                },
                trend: [],
                categories: [],
              },
            }
          : { status: "locked" },
      }),
    }),
  );
  await page.route("**/api/v1/auth/csrf", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { token: "csrf-test" } }),
    }),
  );
  await page.route(`${shareUrl}/unlock`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ passcode: "family9" });
    unlocked = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data: { unlocked: true } }),
    });
  });

  await page.goto(`/s/${token}`);
  await expect(
    page.getByRole("heading", { name: "输入访问口令" }),
  ).toBeVisible();
  await page.getByLabel("访问口令").fill("family9");
  await page.getByRole("button", { name: "查看汇总" }).click();
  await expect(
    page.getByRole("heading", { name: "本人付款，含家庭费用" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "支出汇总" })
      .getByRole("article")
      .filter({ hasText: "净支出" })
      .getByText("¥ 46.50"),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("records a personal expense through the approved ledger form", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          account: {
            id: "account-demo",
            username: "demo",
            nickname: "演示用户",
            systemRole: "USER",
            status: "ACTIVE",
            mustChangePassword: false,
            version: 1,
          },
          family: null,
          mustChangePassword: false,
        },
      }),
    }),
  );
  await page.route("**/api/v1/categories", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [{ id: "category-food", code: "FOOD", name: "餐饮" }],
      }),
    }),
  );
  await page.route("**/api/v1/expenses?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { items: [], nextCursor: null } }),
    }),
  );
  await page.route("**/api/v1/auth/csrf", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { token: "csrf-test" } }),
    }),
  );
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/v1/expenses", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data: { id: "expense-new" } }),
    });
  });

  await page.goto("/");
  if (page.viewportSize()!.width <= 650) {
    await page
      .locator(".mobile-nav")
      .getByRole("button", { name: "账本" })
      .click();
  } else {
    await page
      .locator(".desktop-nav")
      .getByRole("button", { name: "账本" })
      .click();
  }
  await page.getByRole("button", { name: /记一笔/ }).click();
  await page.getByLabel("金额").fill("36.50");
  await page.getByLabel("名称", { exact: true }).fill("午餐");
  await page.getByRole("button", { name: "保存记录" }).click();
  await expect(page.getByRole("status")).toContainText("这笔支出已记下");
  expect(submitted).toMatchObject({
    title: "午餐",
    categoryId: "category-food",
    amount: "36.50",
  });
  expect(submitted).not.toHaveProperty("payerId");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("creates a personal task through the responsive task form", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          account: {
            id: "account-demo",
            username: "demo",
            nickname: "演示用户",
            systemRole: "USER",
            status: "ACTIVE",
            mustChangePassword: false,
            version: 1,
          },
          family: null,
          mustChangePassword: false,
        },
      }),
    }),
  );
  await page.route("**/api/v1/tasks**", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { items: [], nextCursor: null } }),
      });
      return;
    }
    const submitted = route.request().postDataJSON() as Record<string, unknown>;
    expect(submitted).toMatchObject({
      title: "买洗衣液",
      description: "补充家用",
      dueOn: "2026-10-18",
    });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data: { id: "task-new", version: 1 } }),
    });
  });
  await page.route("**/api/v1/auth/csrf", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { token: "csrf-test" } }),
    }),
  );

  await page.goto("/");
  const nav =
    page.viewportSize()!.width <= 650
      ? page.locator(".mobile-nav")
      : page.locator(".desktop-nav");
  await nav.getByRole("button", { name: /待办/ }).click();
  await page.getByRole("button", { name: /新建待办/ }).click();
  const closeDialog = page.getByRole("button", { name: "关闭弹窗" });
  await expect(closeDialog).toBeVisible();
  await page.locator(".ledger-dialog").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const closeBox = await closeDialog.boundingBox();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.width).toBe(36);
  expect(closeBox!.height).toBe(36);
  await page.getByLabel("事项名称").fill("买洗衣液");
  await page.getByLabel("截止日期").fill("2026-10-18");
  await page.getByLabel("补充说明").fill("补充家用");
  await page.getByRole("button", { name: "保存待办" }).click();
  await expect(page.getByRole("status")).toContainText("待办已创建");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
});
