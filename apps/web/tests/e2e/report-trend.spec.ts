import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const trend = Array.from({ length: 23 }, (_, index) => ({
  period: `2026-10-${String(index + 1).padStart(2, "0")}`,
  expense: String(
    index === 1 ? 4971.43 : index === 5 ? 989 : index === 22 ? 180 : 0,
  ),
  refund: "0",
  net: String(
    index === 1 ? 4971.43 : index === 5 ? 989 : index === 22 ? 180 : 0,
  ),
  value: String(
    index === 1 ? 4971.43 : index === 5 ? 989 : index === 22 ? 180 : 0,
  ),
}));
test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/**", (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    let data: unknown = { items: [], nextCursor: null };
    if (endpoint.endsWith("/me"))
      data = {
        account: {
          id: "report-user",
          username: "report",
          nickname: "林然",
          systemRole: "USER",
          status: "ACTIVE",
          mustChangePassword: false,
          version: 1,
        },
        family: null,
        mustChangePassword: false,
      };
    if (endpoint.endsWith("/reports/summary"))
      data = {
        from: "2026-10-01",
        to: "2026-10-23",
        hasData: true,
        scopeLabel: "本人支付",
        expense: "6140.43",
        refund: "0",
        net: "6140.43",
        comparison: {
          from: "2026-09-01",
          to: "2026-09-23",
          net: "0",
          difference: "6140.43",
          percent: null,
          hasData: false,
        },
      };
    if (endpoint.endsWith("/reports/trend")) data = { points: trend };
    if (
      endpoint.endsWith("/reports/categories") ||
      endpoint.endsWith("/reports/members")
    )
      data = [];
    return route.fulfill({ status: 200, json: { data } });
  });
  await page.goto("/");
  await page
    .locator(page.viewportSize()!.width <= 650 ? ".mobile-nav" : ".desktop-nav")
    .getByRole("button", { name: "报表", exact: true })
    .click();
  await expect(page.locator(".report-chart")).toBeVisible();
});
test("plots all days including a spike between sampled labels", async ({
  page,
}) => {
  const coordinates = (await page
    .locator(".report-chart polyline")
    .getAttribute("points"))!
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number));
  expect(coordinates).toHaveLength(23);
  const ys = coordinates.map((point) => point[1]!);
  expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(130);
});
test("shows exact daily values on hover, focus and touch selection", async ({
  page,
}) => {
  const target = page.getByRole("button", { name: /2026-10-02.*4,971.43/ });
  await expect(target).toBeAttached();
  if (page.viewportSize()!.width <= 650) await target.tap();
  else await target.hover();
  await expect(page.locator(".report-chart-tooltip")).toContainText("4,971.43");
  await expect(page.locator(".report-chart-tooltip")).toContainText(
    "2026-10-02",
  );
  await target.focus();
  await expect(page.locator(".report-chart-tooltip")).toContainText("4,971.43");
  await page.mouse.move(0, 0);
  await expect(page.locator(".report-chart-tooltip")).toContainText("4,971.43");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mkdir(path.resolve("../../deliverables/paper-notebook/app-evidence"), {
    recursive: true,
  });
  await expect(page.locator(".report-chart polyline")).toHaveCSS(
    "stroke-dashoffset",
    "0px",
  );
  await page.locator(".trend-panel").screenshot({
    path: path.resolve(
      `../../deliverables/paper-notebook/app-evidence/${page.viewportSize()!.width}-trend-fixed.png`,
    ),
  });
});

test("magnifies daily amounts, marks clipped payments and restores the complete scale", async ({
  page,
}) => {
  const readLine = async () =>
    (await page.locator(".report-chart polyline").getAttribute("points"))!
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(",").map(Number));
  const original = await readLine();
  const controls = page.getByRole("group", {
    name: "趋势图显示范围",
    exact: true,
  });
  await controls.getByRole("button", { name: "放大日常", exact: true }).click();
  await expect(
    page.locator('.report-chart-overflow[data-period="2026-10-02"]'),
  ).toHaveAttribute("data-direction", "above");
  await expect(page.locator(".report-zoom-note")).toContainText(
    "1 个日期超出范围",
  );
  const magnified = await readLine();
  expect(168 - magnified[22]![1]!).toBeGreaterThan(
    (168 - original[22]![1]!) * 2,
  );
  const peak = page.getByRole("button", {
    name: /2026-10-02.*4,971.43.*超出纵轴范围/,
  });
  if (page.viewportSize()!.width <= 650) await peak.tap();
  else await peak.hover();
  await expect(page.locator(".report-chart-tooltip")).toContainText("4,971.43");
  await expect(page.locator(".report-chart-tooltip")).toContainText("真实金额");
  await peak.focus();
  await page.mouse.move(0, 0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .locator(".trend-panel")
    .screenshot({
      path: path.resolve(
        `../../deliverables/paper-notebook/app-evidence/${page.viewportSize()!.width}-trend-daily.png`,
      ),
    });
  await controls.getByRole("button", { name: "完整金额", exact: true }).click();
  await expect(page.locator(".report-chart-overflow")).toHaveCount(0);
  expect(await readLine()).toEqual(original);
  await expect(page.locator(".report-zoom-note")).toHaveCount(0);
});
