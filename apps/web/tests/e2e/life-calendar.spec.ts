import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const account = {
  id: "demo-account",
  nickname: "林然",
  username: "linran",
  systemRole: "USER",
  status: "ACTIVE",
  mustChangePassword: false,
  version: 1,
};
const family = {
  id: "demo-family",
  name: "林间小家",
  adminAccountId: account.id,
  status: "ACTIVE",
  role: "ADMIN",
  version: 1,
  members: [account, { id: "other", nickname: "许宁", username: "xuning" }],
};
const category = { id: "category-daily", code: "DAILY", name: "日用" };
const expense = {
  id: "expense-1",
  title: "日常采购",
  category,
  occurredOn: "2026-10-14",
  amount: "68.50",
  net: "68.50",
  refund: "0",
  quantity: null,
  unit: null,
  unitPrice: null,
  note: null,
  familyId: null,
  payer: account,
  receipts: [],
  refunds: [],
  deletedAt: null,
  purgeAfter: null,
  version: 1,
  capabilities: {
    canEdit: true,
    canRefund: true,
    canDelete: true,
    canRestore: false,
  },
};
const task = {
  id: "task-1",
  title: "预约牙齿检查",
  dueOn: "2026-10-15",
  description: "确认预约时间",
  familyId: null,
  status: "OPEN",
  manager: account,
  assignee: null,
  completedBy: null,
  completedAt: null,
  version: 1,
  canManage: true,
  canComplete: true,
};
const evidenceRoot = path.resolve(
  "../../deliverables/life-calendar/app-evidence",
);

async function setup(page: Page) {
  await page.clock.install({ time: new Date("2026-10-14T10:00:00+08:00") });
  const state = {
    failSave: false,
    net: 3487.9,
    expenses: [{ ...expense }],
    tasks: [{ ...task }],
    holdPersonal: false,
    pending: [] as Route[],
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.replace("/api/v1", "");
    const isFamily = url.searchParams.get("space") === "family";
    const ok = (data: unknown) =>
      route.fulfill({ status: 200, json: { data } });
    if (endpoint === "/me")
      return ok({ account, family, mustChangePassword: false });
    if (endpoint === "/auth/csrf") return ok({ token: "fixture-csrf" });
    if (endpoint === "/categories") return ok([category]);
    if (endpoint === "/reports/summary") {
      if (state.holdPersonal && !isFamily) {
        state.pending.push(route);
        return;
      }
      return ok({
        from: "2026-10-01",
        to: "2026-10-14",
        hasData: true,
        scopeLabel: isFamily ? "家庭归属" : "本人支付",
        expense: "3587.90",
        refund: "100",
        net: isFamily ? "7890.00" : state.net.toFixed(2),
        comparison: {
          from: "2026-09-01",
          to: "2026-09-14",
          net: "3200",
          difference: "287.90",
          percent: 8.99,
          hasData: true,
        },
      });
    }
    if (endpoint === "/reports/trend")
      return ok({
        points: [1, 4, 7, 10, 14].map((day, index) => ({
          period: `2026-10-${String(day).padStart(2, "0")}`,
          expense: String(400 + index * 80),
          refund: "0",
          net: String(400 + index * 80),
          value: String(400 + index * 80),
        })),
      });
    if (endpoint === "/reports/categories")
      return ok([
        {
          categoryId: category.id,
          code: category.code,
          name: category.name,
          expense: "3587.90",
          refund: "100",
          net: "3487.90",
          value: "3487.90",
        },
      ]);
    if (endpoint === "/reports/members")
      return ok([
        {
          payer: account,
          expense: "3587.90",
          refund: "100",
          net: "3487.90",
          value: "3487.90",
        },
      ]);
    if (endpoint === "/reports/details")
      return ok({
        items: [
          {
            id: expense.id,
            kind: "expense",
            occurredOn: expense.occurredOn,
            title: expense.title,
            category,
            payer: account,
            amount: expense.amount,
          },
        ],
        nextCursor: null,
      });
    if (endpoint === "/notification-preferences")
      return ok({
        localTime: "09:00",
        taskAdvanceDays: 1,
        feeAdvanceDays: 3,
        overdueEnabled: true,
      });
    if (endpoint === "/notifications")
      return ok({ items: [], nextCursor: null });
    if (endpoint === "/recurring-rules")
      return ok({
        items: [
          {
            id: "rule-1",
            title: "个人会员订阅",
            status: "ACTIVE",
            familyId: null,
            category,
            frequency: "MONTHLY",
            anchorOn: "2026-10-15",
            expectedAmount: "25",
            version: 1,
            canManage: true,
            occurrences: [
              {
                id: "fee-1",
                title: "个人会员订阅",
                dueOn: "2026-10-15",
                periodKey: "2026-10",
                status: "PENDING",
                version: 1,
                amount: null,
                payerId: null,
                manager: account,
                canPay: true,
                canSkip: true,
              },
            ],
          },
        ],
        nextCursor: null,
      });
    if (endpoint === "/tasks" && request.method() === "GET")
      return ok({
        items: state.tasks.filter(
          (item) =>
            url.searchParams.get("status") !== "open" || item.status === "OPEN",
        ),
        nextCursor: null,
      });
    if (endpoint === "/tasks/task-1/complete") {
      const currentTask = state.tasks.find((item) => item.id === "task-1");
      if (currentTask) currentTask.status = "DONE";
      return ok(state.tasks[0]);
    }
    if (endpoint === "/expenses" && request.method() === "POST") {
      if (state.failSave)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "TEMPORARY_ERROR",
              message: "暂时无法保存，请重试。",
            },
          },
        });
      const body = request.postDataJSON();
      const created = {
        ...expense,
        ...body,
        id: "created-expense",
        net: body.amount,
      };
      state.expenses.push(created);
      state.net += Number(body.amount);
      return ok(created);
    }
    if (endpoint === "/expenses")
      return ok({ items: state.expenses, nextCursor: null });
    if (endpoint.startsWith("/expenses/"))
      return ok(
        state.expenses.find((item) => item.id === endpoint.split("/")[2]),
      );
    return route.fulfill({
      status: 404,
      json: { error: { code: "UNHANDLED_FIXTURE", message: endpoint } },
    });
  });
  return state;
}

function navigation(page: Page) {
  return page.locator(
    page.viewportSize()!.width <= 650 ? ".mobile-nav" : ".desktop-nav",
  );
}
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}
async function capture(page: Page, name: string) {
  await settle(page);
  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceRoot, `${page.viewportSize()!.width}-${name}.png`),
    fullPage: false,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test("five pages, mobile icons and reduced motion retain the selected design", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setup(page);
  await page.goto("/");
  await expect(page.locator(".life-amount")).toContainText("3,487.90");
  await expect(page.locator(".life-task")).toHaveCount(2);
  await expect(navigation(page).locator("button .ui-icon")).toHaveCount(5);
  await capture(page, "home");
  for (const [label, selector, file] of [
    ["账本", ".ledger-row", "ledger"],
    ["待办与提醒", ".task-row", "tasks"],
    ["报表", ".report-metric", "reports"],
    ["我的", ".reminder-settings", "profile"],
  ] as const) {
    await navigation(page)
      .getByRole("button", {
        name: label === "待办与提醒" ? /待办/ : label,
        exact: label !== "待办与提醒",
      })
      .click();
    await expect(page.locator(selector).first()).toBeVisible();
    await capture(page, file);
    if (file === "reports") {
      await page.locator(".report-chart-labels").scrollIntoViewIfNeeded();
      await capture(page, "reports-trend");
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await navigation(page)
    .getByRole("button", { name: "首页", exact: true })
    .click();
  await expect(page.locator(".life-amount")).toContainText("3,487.90");
  const animation = await page
    .locator(".life-agenda")
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(animation).toBe("none");
  if (page.viewportSize()!.width <= 650) {
    await page.setViewportSize({ width: 320, height: 740 });
    await capture(page, "home-narrow");
    for (const label of ["账本", "报表", "我的"]) {
      await navigation(page)
        .getByRole("button", { name: label, exact: true })
        .click();
      await expect(
        page.locator(
          label === "账本"
            ? ".ledger-paper"
            : label === "报表"
              ? ".report-metrics"
              : ".reminder-settings",
        ),
      ).toBeVisible();
      await capture(page, `${label}-narrow`);
    }
  }
  expect(errors).toEqual([]);
});

test("home capture reuses the ledger form, retains failed input, and reads saved state after reload", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/");
  await page.getByRole("button", { name: /记一笔.*记录日常消费/ }).click();
  const dialog = page.getByRole("dialog", { name: "记一笔", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("金额", { exact: true }).fill("28.60");
  await dialog.getByLabel("名称", { exact: true }).fill("周末鲜花");
  state.failSave = true;
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("alert")).toContainText("暂时无法保存");
  await expect(dialog.getByLabel("金额", { exact: true })).toHaveValue("28.60");
  await expect(dialog.getByLabel("名称", { exact: true })).toHaveValue(
    "周末鲜花",
  );
  await capture(page, "form-save-failed");
  state.failSave = false;
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator(".ledger-row").filter({ hasText: "周末鲜花" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".life-amount")).toContainText("3,516.50");
  await page.getByRole("button", { name: /新建待办.*提醒自己的事/ }).click();
  const taskDialog = page.getByRole("dialog", {
    name: "新建待办",
    exact: true,
  });
  await expect(taskDialog.getByLabel("事项名称")).toBeFocused();
  await capture(page, "task-form");
  await page.keyboard.press("Escape");
  await expect(taskDialog).toHaveCount(0);
  await page.getByRole("button", { name: "完成：预约牙齿检查" }).click();
  await expect(page.locator(".task-row")).toHaveCount(0);
  await navigation(page)
    .getByRole("button", { name: "首页", exact: true })
    .click();
  await expect(page.locator(".life-task")).toHaveCount(1);
});

test("late personal responses cannot replace the current family overview", async ({
  page,
}) => {
  const state = await setup(page);
  state.holdPersonal = true;
  await page.goto("/");
  await expect.poll(() => state.pending.length).toBe(1);
  const switcher =
    page.viewportSize()!.width <= 650
      ? page.locator(".mobile-current-space")
      : page
          .locator(".scope-switch")
          .getByRole("button", { name: "家庭", exact: true });
  await switcher.click();
  await expect(page.locator(".life-amount")).toContainText("7,890.00");
  await expect(page.getByRole("heading", { name: "家庭日常" })).toBeVisible();
  const pending = state.pending[0];
  if (!pending) throw new Error("Expected pending personal request");
  await pending.fulfill({
    status: 200,
    json: { data: { net: "123.45", hasData: true } },
  });
  await settle(page);
  await expect(page.locator(".life-amount")).toContainText("7,890.00");
  await expect(page.locator(".life-privacy")).toHaveText(
    "家庭事项会提醒所有当前成员。",
  );
});
