import { describe, expect, it, vi } from "vitest";
import {
  ReportsService,
  comparisonRange,
} from "../../src/modules/reports/reports.service.js";
import type { PrismaService } from "../../src/shared/database/prisma.service.js";

describe("report calendar comparisons", () => {
  it("compares a partial month with the same progress in the previous month", () => {
    expect(
      comparisonRange({
        space: "personal",
        origin: "all",
        from: "2026-03-01",
        to: "2026-03-15",
        period: "month",
        granularity: "day",
        basis: "net",
      }),
    ).toEqual({ from: "2026-02-01", to: "2026-02-15" });
  });

  it("clamps a leap-day yearly comparison to February 28", () => {
    expect(
      comparisonRange({
        space: "personal",
        origin: "all",
        from: "2024-01-01",
        to: "2024-02-29",
        period: "year",
        granularity: "month",
        basis: "net",
      }),
    ).toEqual({ from: "2023-01-01", to: "2023-02-28" });
  });
});

describe("report summary", () => {
  it("separates current-period expenses and refunds and scopes personal data to the payer", async () => {
    const expenseAggregate = vi.fn(async ({ where }: { where: any }) => {
      const isCurrent = where.occurredOn.gte
        .toISOString()
        .startsWith("2026-03");
      return {
        _sum: { amountCents: isCurrent ? 15000n : 10000n },
        _count: 1,
      };
    });
    const refundAggregate = vi.fn(async ({ where }: { where: any }) => {
      const isCurrent = where.occurredOn.gte
        .toISOString()
        .startsWith("2026-03");
      return {
        _sum: { amountCents: isCurrent ? 2500n : 0n },
        _count: isCurrent ? 1 : 0,
      };
    });
    const service = new ReportsService({
      expense: { aggregate: expenseAggregate },
      refund: { aggregate: refundAggregate },
    } as unknown as PrismaService);

    const result = await service.summary("account-1", {
      space: "personal",
      origin: "personal",
      from: "2026-03-01",
      to: "2026-03-31",
      period: "month",
      granularity: "day",
      basis: "net",
    });

    expect(result).toMatchObject({
      expense: "150.00",
      refund: "25.00",
      net: "125.00",
      comparison: {
        expense: "100.00",
        refund: "0.00",
        net: "100.00",
        difference: "25.00",
        percent: 25,
      },
    });
    expect(expenseAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          payerId: "account-1",
          familyId: null,
        }),
      }),
    );
    expect(refundAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          expense: {
            is: expect.objectContaining({
              payerId: "account-1",
              familyId: null,
            }),
          },
        }),
      }),
    );
  });
});
