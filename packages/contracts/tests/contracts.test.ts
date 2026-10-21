import { describe, expect, it } from "vitest";
import {
  expenseCategories,
  garmentCreateRequestSchema,
  healthResponseSchema,
  reportQuerySchema,
  wardrobeDailyRecommendationRequestSchema,
  wardrobeRecommendationRequestSchema,
} from "../src/index.js";

describe("shared contracts", () => {
  it("keeps utility categories individually reportable", () => {
    expect(
      expenseCategories.filter(({ code }) =>
        ["WATER", "ELECTRICITY", "GAS"].includes(code),
      ),
    ).toHaveLength(3);
  });

  it("validates a healthy service response", () => {
    expect(
      healthResponseSchema.safeParse({
        status: "ok",
        service: "homedata-api",
        timestamp: new Date().toISOString(),
        checks: { database: "ok" },
      }).success,
    ).toBe(true);
  });

  it("limits report queries to the selected calendar period", () => {
    const base = {
      space: "personal",
      origin: "all",
      period: "month",
      from: "2026-02-01",
      to: "2026-02-28",
    };
    expect(reportQuerySchema.safeParse(base).success).toBe(true);
    expect(
      reportQuerySchema.safeParse({ ...base, to: "2026-03-01" }).success,
    ).toBe(false);
    expect(
      reportQuerySchema.safeParse({
        ...base,
        period: "day",
      }).success,
    ).toBe(false);
  });

  it("accepts multiple distinct seasons and rejects duplicate values", () => {
    const garment = {
      name: "针织衫",
      category: "TOP",
      ownerId: "00000000-0000-4000-8000-000000000001",
      mainImageId: "00000000-0000-4000-8000-000000000002",
      seasons: ["SPRING", "AUTUMN"],
      layers: ["INNER"],
      scenes: [],
      expenseMode: "NONE",
    };
    expect(garmentCreateRequestSchema.safeParse(garment).success).toBe(true);
    expect(
      garmentCreateRequestSchema.safeParse({
        ...garment,
        seasons: ["SPRING", "SPRING"],
      }).success,
    ).toBe(false);
    expect(
      garmentCreateRequestSchema.safeParse({
        ...garment,
        ownerId: "not-an-account-id",
      }).success,
    ).toBe(false);
    expect(
      garmentCreateRequestSchema.safeParse({
        ...garment,
        visibility: "FAMILY",
      }).success,
    ).toBe(false);
  });

  it("requires exactly the expense fields selected by the garment expense mode", () => {
    const garment = {
      name: "外套",
      category: "OUTERWEAR",
      ownerId: "00000000-0000-4000-8000-000000000001",
      mainImageId: "00000000-0000-4000-8000-000000000002",
      seasons: [],
      layers: ["OUTER"],
      scenes: [],
    };
    expect(
      garmentCreateRequestSchema.safeParse({ ...garment, expenseMode: "NONE" })
        .success,
    ).toBe(true);
    expect(
      garmentCreateRequestSchema.safeParse({
        ...garment,
        stylingAdvice: "适合通勤，搭配简洁下装。",
        expenseMode: "NONE",
      }).success,
    ).toBe(true);
    expect(
      garmentCreateRequestSchema.safeParse({
        ...garment,
        stylingAdvice: "建议".repeat(61),
        expenseMode: "NONE",
      }).success,
    ).toBe(false);
    expect(
      garmentCreateRequestSchema.safeParse({
        ...garment,
        expenseMode: "EXISTING",
        expenseId: "00000000-0000-4000-8000-000000000003",
        expense: {},
      }).success,
    ).toBe(false);
  });

  it("limits trip recommendation inputs to a destination and one to thirty days", () => {
    const trip = {
      mode: "TRIP",
      scene: "CASUAL",
      city: {
        name: "京都",
        countryCode: "JP",
        latitude: 35.0116,
        longitude: 135.7681,
        timezone: "Asia/Tokyo",
      },
      startOn: "2026-12-31",
      days: 30,
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
    };
    expect(wardrobeRecommendationRequestSchema.safeParse(trip).success).toBe(
      true,
    );
    expect(
      wardrobeRecommendationRequestSchema.safeParse({ ...trip, days: 31 })
        .success,
    ).toBe(false);
    expect(
      wardrobeRecommendationRequestSchema.safeParse({
        ...trip,
        startOn: "2026-02-30",
      }).success,
    ).toBe(false);
  });

  it("accepts a bounded optional outfit idea for daily and trip recommendations", () => {
    const daily = wardrobeDailyRecommendationRequestSchema.parse({
      scene: "CASUAL",
      idea: "  想轻薄叠穿  ",
    });
    expect(daily.idea).toBe("想轻薄叠穿");
    expect(
      wardrobeDailyRecommendationRequestSchema.safeParse({
        scene: "CASUAL",
        idea: "a".repeat(161),
      }).success,
    ).toBe(false);

    const trip = {
      mode: "TRIP" as const,
      scene: "CASUAL" as const,
      city: {
        name: "京都",
        countryCode: "JP",
        latitude: 35.0116,
        longitude: 135.7681,
        timezone: "Asia/Tokyo",
      },
      startOn: "2026-12-31",
      days: 3,
      idempotencyKey: "00000000-0000-4000-8000-000000000003",
    };
    expect(
      wardrobeRecommendationRequestSchema.safeParse({
        ...trip,
        idea: "想轻便一点",
      }).success,
    ).toBe(true);
    expect(
      wardrobeRecommendationRequestSchema.safeParse({
        ...trip,
        idea: "a".repeat(161),
      }).success,
    ).toBe(false);
  });
});
