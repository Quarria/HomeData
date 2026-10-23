export type TrendScaleMode = "full" | "daily";

function roundUp(value: number) {
  const unit = 10 ** Math.floor(Math.log10(value));
  return (
    [1, 2, 5, 10].map((step) => step * unit).find((step) => step >= value) ??
    value
  );
}

export function trendScale(values: number[], mode: TrendScaleMode) {
  const finite = values.filter(Number.isFinite);
  const min = Math.min(0, ...finite);
  const max = Math.max(0, ...finite);
  const amounts = finite
    .map(Math.abs)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  // Ignore zero-spend days when estimating a useful daily range. A lower
  // median keeps a single large payment from setting the magnification.
  const median = amounts[Math.floor((amounts.length - 1) / 2)];
  const cap =
    mode === "daily" && median !== undefined ? roundUp(median * 2) : Infinity;
  const lower = Math.max(min, -cap);
  const upper = Math.min(max, cap);
  const empty = lower === 0 && upper === 0;
  return {
    min: empty ? -1 : lower,
    max: empty ? 1 : upper,
    clipped: finite.filter((value) => value < lower || value > upper).length,
  };
}
