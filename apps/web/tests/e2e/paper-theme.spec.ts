import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const evidence = path.resolve("../../deliverables/paper-notebook/app-evidence");

test("four daily palettes persist, default to blue, and keep the picker within the viewport", async ({
  page,
}) => {
  await page.route("**/api/v1/**", (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    let data: unknown = { items: [], nextCursor: null };
    if (endpoint.endsWith("/me"))
      data = {
        account: {
          id: "theme-account",
          username: "theme",
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
      data = { net: "3286.50", hasData: true };
    return route.fulfill({ status: 200, json: { data } });
  });
  await page.goto("/");
  await expect(page.locator(".life-amount")).toContainText("3,286.50");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-theme",
    "blue",
  );
  await mkdir(evidence, { recursive: true });
  for (const [id, label] of [
    ["blue", "明黄 × 雾蓝"],
    ["sun", "暖黄 × 墨黑"],
    ["sage", "奶黄 × 鼠尾草"],
    ["pink", "鹅黄 × 杏桃"],
  ] as const) {
    await page.getByLabel("日常配色", { exact: true }).click();
    const option = page.getByRole("button", { name: label, exact: true });
    await option.click();
    await expect(option).toHaveAttribute("aria-pressed", "true");
    const box = await page.locator(".theme-menu").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.keyboard.press("Escape");
    await expect(page.locator(".theme-picker")).not.toHaveAttribute("open");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-color-theme", id);
    await expect(page.locator(".life-amount")).toContainText("3,286.50");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.screenshot({
      path: path.join(
        evidence,
        `${page.viewportSize()!.width}-theme-${id}.png`,
      ),
      fullPage: true,
    });
  }
  await page.evaluate(() =>
    localStorage.setItem("homedata:daily-color-theme", "invalid"),
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-theme",
    "blue",
  );
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByLabel("日常配色", { exact: true }).click();
  const narrowBox = await page.locator(".theme-menu").boundingBox();
  expect(narrowBox!.x).toBeGreaterThanOrEqual(0);
  expect(narrowBox!.x + narrowBox!.width).toBeLessThanOrEqual(320);
});
