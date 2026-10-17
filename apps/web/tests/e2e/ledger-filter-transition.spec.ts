import { expect, test } from "@playwright/test";

const account = {
  id: "demo-account",
  username: "demo",
  nickname: "演示用户",
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
  version: 1,
  role: "ADMIN",
  members: [account],
};
const category = { id: "category-home", code: "HOME", name: "日用" };

function expense(id: string, title: string, familyId: string | null) {
  return {
    id,
    title,
    category,
    occurredOn: "2026-10-18",
    amount: "68.50",
    net: "68.50",
    refund: "0",
    quantity: null,
    unit: null,
    unitPrice: null,
    note: null,
    familyId,
    familyName: familyId ? family.name : null,
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
}

test("fades the previous ledger results while the selected filter loads", async ({
  page,
}) => {
  const personalExpenses = Array.from({ length: 10 }, (_, index) =>
    expense(`personal-${index}`, `个人记录 ${index}`, null),
  );
  const familyExpenses = Array.from({ length: 4 }, (_, index) =>
    expense(`family-${index}`, `家庭记录 ${index}`, family.id),
  );
  let familyLoadCount = 0;
  let delayNextAllLoad = false;
  let captureFastFamilyOpacity = false;
  let opacityAtFastFamilyRequest: number | null = null;

  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const endpoint = url.pathname.replace("/api/v1", "");
    const ok = (data: unknown) =>
      route.fulfill({ status: 200, json: { data } });

    if (endpoint === "/me")
      return ok({ account, family, mustChangePassword: false });
    if (endpoint === "/categories") return ok([category]);
    if (endpoint === "/reports/summary")
      return ok({ net: "0", hasData: false });
    if (endpoint === "/tasks" || endpoint === "/recurring-rules")
      return ok({ items: [], nextCursor: null });
    if (endpoint === "/expenses") {
      const isFamily = url.searchParams.get("origin") === "family";
      if (isFamily) {
        const delay = familyLoadCount++ === 0 ? 500 : 0;
        if (captureFastFamilyOpacity) {
          captureFastFamilyOpacity = false;
          opacityAtFastFamilyRequest = await page
            .locator(".ledger-row-list")
            .first()
            .evaluate((element) => Number(getComputedStyle(element).opacity));
        }
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      } else if (delayNextAllLoad) {
        delayNextAllLoad = false;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const items = isFamily ? familyExpenses : personalExpenses;
      return ok({ items, nextCursor: null });
    }

    return ok({});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "账本", exact: true }).click();
  await expect(page.locator(".ledger-row")).toHaveCount(10);

  await page
    .locator(".ledger-origin")
    .getByRole("button", { name: "家庭费用", exact: true })
    .click();

  await expect(page.locator(".ledger-row-list").first()).toHaveCSS(
    "opacity",
    "0",
    { timeout: 400 },
  );
  await expect(page.locator(".ledger-row")).toHaveCount(4);
  await expect(page.locator(".ledger-row").first()).toContainText("家庭记录");

  delayNextAllLoad = true;
  await page
    .locator(".ledger-origin")
    .getByRole("button", { name: "全部", exact: true })
    .click();
  captureFastFamilyOpacity = true;
  await page
    .locator(".ledger-origin")
    .getByRole("button", { name: "家庭费用", exact: true })
    .click();
  await expect.poll(() => opacityAtFastFamilyRequest).not.toBeNull();
  expect(opacityAtFastFamilyRequest).toBe(0);
  await expect(page.locator(".ledger-row")).toHaveCount(4);
  await page.waitForTimeout(450);
  await expect(page.locator(".ledger-row")).toHaveCount(4);
  await expect(page.locator(".ledger-row").first()).toContainText("家庭记录");
});
