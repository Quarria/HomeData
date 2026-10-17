import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(resolve("apps/web/package.json"));
const { chromium, expect } = require("@playwright/test");
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const results = [];
try {
  for (const width of [1440, 768, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:4173/");
    await expect(page.locator("#main h1")).toHaveText("个人日常");
    await expect(page.locator("#main .calendar-day")).toHaveCount(7);
    const nav = width <= 700 ? "#mobile-nav" : "#desktop-nav";
    for (const destination of ["ledger", "tasks", "reports", "profile", "home"]) {
      await page.locator(`${nav} [data-page=${destination}]`).click();
      await expect(page.locator(`${nav} [data-page=${destination}]`)).toHaveAttribute("aria-current", "page");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.locator("#main [data-action=expense]").click();
    await expect(page.locator("#dialog")).toBeVisible();
    await page.locator("#expense-form [name=amount]").fill("12.34");
    await page.locator("#expense-form [name=name]").fill("界面核验条目");
    await page.locator("#expense-form button").last().click();
    await expect(page.locator("#dialog")).not.toBeVisible();
    await expect(page.locator("#main .month-summary .amount")).toContainText("3,500.24");
    await page.locator(`${nav} [data-page=ledger]`).click();
    await expect(page.locator("#main")).toContainText("界面核验条目");
    await page.reload();
    await expect(page.locator("#main .month-summary .amount")).toContainText("3,487.90");
    await page.locator("#main [data-action=task-detail]").click();
    await page.locator("#dialog [data-action=task-toggle-modal]").click();
    await expect(page.locator("#main [data-action=task-detail]")).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(`${nav} [data-page=ledger]`).click();
    await page.locator(`${nav} [data-page=home]`).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
    results.push({ viewport: width, pages: 5, captureAndTotal: "passed", refreshResetsDemo: "passed", completeTask: "passed", reducedMotion: "passed", errors });
    await page.close();
  }
} finally { await browser.close(); }
await mkdir("deliverables/life-calendar/prototype-evidence", { recursive: true });
await writeFile("deliverables/life-calendar/prototype-evidence/verification.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
