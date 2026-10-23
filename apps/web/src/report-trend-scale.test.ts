import { describe, expect, it } from "vitest";
import { trendScale } from "./report-trend-scale";

describe("report daily scale", () => {
  it("keeps the full magnitude by default", () => {
    expect(trendScale([0, 35, 50, 80, 5000], "full")).toEqual({
      min: 0,
      max: 5000,
      clipped: 0,
    });
  });
  it("magnifies everyday amounts without letting zero days or the outlier set the range", () => {
    expect(trendScale([0, 0, 0, 0, 35, 50, 80, 5000], "daily")).toEqual({
      min: 0,
      max: 100,
      clipped: 1,
    });
  });
  it("handles large refunds symmetrically", () => {
    expect(trendScale([-5000, -40, 50, 80], "daily")).toEqual({
      min: -100,
      max: 80,
      clipped: 1,
    });
  });
  it("does not manufacture clipping when there is only one nonzero amount", () => {
    expect(trendScale([0, 5000], "daily")).toEqual({
      min: 0,
      max: 5000,
      clipped: 0,
    });
  });
  it("supports no data, all zeroes and amounts smaller than one yuan", () => {
    expect(trendScale([], "daily")).toEqual({ min: -1, max: 1, clipped: 0 });
    expect(trendScale([0, 0], "daily")).toEqual({
      min: -1,
      max: 1,
      clipped: 0,
    });
    expect(trendScale([0.01, 0.02, 500], "daily")).toEqual({
      min: 0,
      max: 0.05,
      clipped: 1,
    });
  });
});
