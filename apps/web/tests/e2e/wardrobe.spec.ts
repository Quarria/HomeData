import { expect, test } from "@playwright/test";
import { garmentCreateRequestSchema } from "@homedata/contracts";

const account = {
  id: "00000000-0000-4000-8000-000000000001",
  username: "demo",
  nickname: "演示用户",
  systemRole: "USER",
  status: "ACTIVE",
  mustChangePassword: false,
  version: 1,
};
const recognitionImageId = "00000000-0000-4000-8000-000000000002";
const recognitionRunId = "00000000-0000-4000-8000-000000000003";
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWPY3dGxu6ODAUIBADMOBy3W07hNAAAAAElFTkSuQmCC",
  "base64",
);

test("opens the closet from home and saves a manually entered garment", async ({
  page,
}) => {
  let saved: Record<string, unknown> | null = null;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.replace("/api/v1", "");
    const ok = (data: unknown) =>
      route.fulfill({ status: 200, json: { data } });
    if (endpoint === "/me")
      return ok({ account, family: null, mustChangePassword: false });
    if (endpoint === "/auth/csrf") return ok({ token: "wardrobe-csrf" });
    if (endpoint === "/categories") return ok([]);
    if (endpoint === "/reports/summary")
      return ok({ net: "0.00", hasData: false });
    if (endpoint === "/tasks" || endpoint === "/recurring-rules")
      return ok({ items: [], nextCursor: null });
    if (endpoint === "/wardrobe/garments" && request.method() === "GET")
      return ok({ items: saved ? [saved] : [], nextCursor: null });
    if (endpoint === "/wardrobe/images" && request.method() === "POST")
      return ok({
        id: "wardrobe-e2e-image",
        contentUrl: "/api/v1/wardrobe/images/wardrobe-e2e-image/content",
        thumbnailUrl:
          "/api/v1/wardrobe/images/wardrobe-e2e-image/content?size=thumbnail",
      });
    if (endpoint === "/wardrobe/garments" && request.method() === "POST") {
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(body.expenseMode).toBe("NONE");
      expect(body.seasons).toEqual(["SPRING", "AUTUMN"]);
      expect(body.stylingAdvice).toBe("适合通勤，搭配简洁下装。");
      saved = {
        id: "wardrobe-e2e-garment",
        ownerId: account.id,
        createdById: account.id,
        familyId: null,
        name: body.name,
        category: body.category,
        color: body.color,
        stylingAdvice: body.stylingAdvice,
        seasons: body.seasons,
        layers: body.layers,
        scenes: body.scenes,
        status: body.status,
        visibility: body.visibility,
        storageLocation: body.storageLocation,
        notes: body.notes,
        acquiredOn: body.acquiredOn,
        version: 1,
        mainImage: {
          id: "wardrobe-e2e-image",
          mimeType: "image/webp",
          contentUrl: "/api/v1/wardrobe/images/wardrobe-e2e-image/content",
          thumbnailUrl:
            "/api/v1/wardrobe/images/wardrobe-e2e-image/content?size=thumbnail",
        },
      };
      return ok(saved);
    }
    if (request.method() === "DELETE") return ok({ deleted: true });
    return ok({ items: [], nextCursor: null });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /打开智能衣柜/ }).click();
  await expect(page.getByRole("heading", { name: "衣柜还空着" })).toBeVisible();
  await page.getByRole("button", { name: "添加第一件衣物" }).click();
  await page.getByLabel("衣物名称").fill("春秋针织衫");
  await page.getByLabel("AI 穿搭建议").fill("适合通勤，搭配简洁下装。");
  await page.getByLabel("春", { exact: true }).check();
  await page.getByLabel("秋", { exact: true }).check();
  await page.locator('input[type="file"]').setInputFiles({
    name: "knit.png",
    mimeType: "image/png",
    buffer: imageBytes,
  });
  await expect(page.getByText("更换照片")).toBeVisible();
  await page.getByRole("button", { name: "保存衣物" }).click();
  await expect(page.getByRole("heading", { name: "春秋针织衫" })).toBeVisible();
});

test("shows recognition progress and prevents duplicate AI requests", async ({
  page,
}) => {
  let recognitionRequests = 0;
  let saved: Record<string, unknown> | null = null;
  let validationIssues: unknown;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.replace("/api/v1", "");
    const ok = (data: unknown) =>
      route.fulfill({ status: 200, json: { data } });
    if (endpoint === "/me")
      return ok({ account, family: null, mustChangePassword: false });
    if (endpoint === "/auth/csrf") return ok({ token: "wardrobe-csrf" });
    if (endpoint === "/ai/status") return ok({ enabled: true });
    if (endpoint === "/categories") return ok([]);
    if (endpoint === "/reports/summary")
      return ok({ net: "0.00", hasData: false });
    if (endpoint === "/tasks" || endpoint === "/recurring-rules")
      return ok({ items: [], nextCursor: null });
    if (endpoint === "/wardrobe/garments" && request.method() === "GET")
      return ok({ items: saved ? [saved] : [], nextCursor: null });
    if (endpoint === "/wardrobe/garments" && request.method() === "POST") {
      const parsed = garmentCreateRequestSchema.safeParse(
        request.postDataJSON(),
      );
      if (!parsed.success) {
        validationIssues = parsed.error.issues;
        return route.fulfill({
          status: 422,
          json: {
            error: {
              code: "REQUEST_VALIDATION_FAILED",
              message: "REQUEST_VALIDATION_FAILED",
              fields: Object.fromEntries(
                parsed.error.issues.map((issue) => [
                  issue.path.join("."),
                  issue.message,
                ]),
              ),
            },
            meta: { requestId: null },
          },
        });
      }
      saved = {
        ...parsed.data,
        id: "wardrobe-recognition-garment",
        ownerId: account.id,
        createdById: account.id,
        familyId: null,
        version: 1,
        mainImage: {
          id: "wardrobe-recognition-image",
          mimeType: "image/webp",
          contentUrl:
            "/api/v1/wardrobe/images/wardrobe-recognition-image/content",
          thumbnailUrl:
            "/api/v1/wardrobe/images/wardrobe-recognition-image/content?size=thumbnail",
        },
      };
      return ok(saved);
    }
    if (endpoint === "/wardrobe/images" && request.method() === "POST")
      return ok({
        id: recognitionImageId,
        contentUrl: `/api/v1/wardrobe/images/${recognitionImageId}/content`,
        thumbnailUrl: `/api/v1/wardrobe/images/${recognitionImageId}/content?size=thumbnail`,
      });
    if (
      endpoint === "/ai/wardrobe-recognitions" &&
      request.method() === "POST"
    ) {
      recognitionRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 600));
      return ok({ id: recognitionRunId, status: "PENDING" });
    }
    if (endpoint === `/ai/runs/${recognitionRunId}`)
      return ok({
        status: "SUCCEEDED",
        errorCode: null,
        result: {
          name: "米色针织衫",
          category: "TOP",
          color: "米色",
          stylingAdvice: "适合日常通勤。",
          seasons: ["SPRING", "AUTUMN"],
          layers: ["MID"],
          scenes: ["COMMUTE"],
          thingsToVerify: [],
        },
      });
    if (request.method() === "DELETE") return ok({ deleted: true });
    return ok({ items: [], nextCursor: null });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /打开智能衣柜/ }).click();
  await page.getByRole("button", { name: "添加第一件衣物" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "knit.png",
    mimeType: "image/png",
    buffer: imageBytes,
  });
  await expect(page.getByText("更换照片")).toBeVisible();

  const recognizeButton = page.getByRole("button", {
    name: "AI 识别并填入草稿",
  });
  await expect(recognizeButton).toBeVisible();
  await recognizeButton.click();

  const recognizingButton = page.getByRole("button", { name: "正在识别…" });
  await expect(recognizingButton).toBeDisabled();
  await expect(
    recognizingButton.locator(".wardrobe-recognition-spinner"),
  ).toBeVisible();
  await recognizingButton.dispatchEvent("click");
  await expect.poll(() => recognitionRequests).toBe(1);
  await expect(page.getByRole("status")).toHaveText(
    "AI 草稿已填入，请核对后保存。",
    { timeout: 5000 },
  );
  await expect(page.getByLabel("衣物名称")).toHaveValue("米色针织衫");
  await page.getByRole("button", { name: "保存衣物" }).click();
  expect(validationIssues, JSON.stringify(validationIssues)).toBeUndefined();
  await expect(page.getByRole("heading", { name: "米色针织衫" })).toBeVisible();
});
