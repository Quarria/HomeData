import { describe, expect, it } from "vitest";
import {
  currentOccurrence,
  firstOccurrenceOnOrAfter,
  followingOccurrence,
  localDateAt,
  localSlotUtc,
  nextCycleOccurrence,
  shiftDate,
} from "../../src/modules/tasks/schedule.js";

describe("recurring calendar calculations", () => {
  it("clamps a month end to the last day of the current month", () => {
    const result = currentOccurrence(
      "MONTHLY",
      new Date("2026-01-31T00:00:00.000Z"),
      new Date("2026-02-15T04:00:00.000Z"),
    );
    expect(result.periodKey).toBe("2026-02");
    expect(result.localDueOn).toBe("2026-02-28");
  });

  it("uses February 28 for an annual February 29 due date in a common year", () => {
    const result = currentOccurrence(
      "YEARLY",
      new Date("2024-02-29T00:00:00.000Z"),
      new Date("2027-01-01T00:00:00.000Z"),
    );
    expect(result.periodKey).toBe("2027");
    expect(result.localDueOn).toBe("2027-02-28");
  });

  it("returns to the original day after a shortened calendar period", () => {
    const nextMonth = followingOccurrence(
      "MONTHLY",
      new Date("2026-01-31T00:00:00.000Z"),
      "2026-02",
    );
    const nextYear = followingOccurrence(
      "YEARLY",
      new Date("2024-02-29T00:00:00.000Z"),
      "2027",
    );
    expect(nextMonth.localDueOn).toBe("2026-03-31");
    expect(nextYear.localDueOn).toBe("2028-02-29");
  });

  it("finds the first valid occurrence on or after a schedule activation date", () => {
    const anchor = new Date("2026-10-20T00:00:00.000Z");
    expect(
      firstOccurrenceOnOrAfter("MONTHLY", anchor, "2026-10-21").periodKey,
    ).toBe("2026-11");
    expect(
      firstOccurrenceOnOrAfter("MONTHLY", anchor, "2026-10-20").periodKey,
    ).toBe("2026-10");
  });

  it("starts a resumed recurring rule with the period after the current one", () => {
    const next = nextCycleOccurrence(
      "MONTHLY",
      new Date("2026-10-20T00:00:00.000Z"),
      new Date("2026-10-15T01:00:00.000Z"),
    );
    expect(next.periodKey).toBe("2026-11");
  });

  it("uses Beijing local dates and slots independently from UTC midnight", () => {
    expect(localDateAt(new Date("2026-10-14T17:00:00.000Z"))).toBe(
      "2026-10-15",
    );
    expect(localSlotUtc("2026-10-15", "09:00").toISOString()).toBe(
      "2026-10-15T01:00:00.000Z",
    );
  });

  it("shifts advance dates across month and year boundaries", () => {
    expect(shiftDate("2027-01-02", -3)).toBe("2026-12-30");
  });
});
