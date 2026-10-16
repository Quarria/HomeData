import { describe, expect, it } from "vitest";
import {
  expenseCategories,
  healthResponseSchema,
  reportQuerySchema,
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
});
