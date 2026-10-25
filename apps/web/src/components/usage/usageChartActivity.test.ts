import { describe, expect, it } from "vite-plus/test";
import {
  estimatedQuotaDrop,
  quotaPercentCrossings,
  chartActivityIntervals,
  quotaActivityPoints,
  visibleChartActivity,
  type ChartActivity,
} from "./usageChartActivity";

const start = Date.parse("2026-09-01T00:00:00Z");
const at = (hour: number) => new Date(start + hour * 3_600_000).toISOString();
const sample = (hour: number, remainingPercent: number) => ({
  observedAt: at(hour),
  remainingPercent,
  resetsAt: at(168),
});
const bin = (from: number, to: number, cost: number | null): ChartActivity => ({
  interval: { id: `${from}`, sinceTime: at(from), untilTime: at(to) },
  models:
    cost === null
      ? null
      : [
          {
            model: "gpt-6-astra",
            costUsd: cost,
            unpricedRecords: 0,
            totals: {
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 100,
              reasoningTokens: 0,
            },
          },
        ],
});

describe("quota activity reconstruction", () => {
  it("marks integer crossings once and never crosses a reset", () => {
    const points = quotaActivityPoints(
      [sample(0, 90), sample(2, 88)],
      [bin(0, 1, 75), bin(1, 2, 25)],
    );
    const crossings = quotaPercentCrossings(points);
    expect(crossings.map((point) => point.percent)).toEqual([89, 88]);
    expect(crossings[0]?.at).toBeCloseTo(start + 2_400_000);
    expect(crossings[1]?.at).toBe(start + 7_200_000);
    expect(quotaPercentCrossings(quotaActivityPoints([sample(0, 20), sample(2, 100)], []))).toEqual(
      [],
    );
  });
  it("spreads a whole-percent drop through repeated integer readings", () => {
    const points = quotaActivityPoints(
      [sample(0, 90), sample(0.5, 90), sample(1, 89), sample(1.5, 89), sample(2, 88)],
      [bin(0, 0.5, 75), bin(0.5, 1, 25), bin(1, 1.5, 25), bin(1.5, 2, 75)],
    );
    expect(points.map((p) => p.remainingPercent)).toEqual([90, 89.25, 89, 88.75, 88]);
    expect(points.map((p) => p.estimated)).toEqual([false, true, false, true, false]);
  });
  it("estimates an unfinished percent using the prior drop's cost and stays within its band", () => {
    const rows = [sample(0, 90), sample(1, 89), sample(2, 89)];
    const points = quotaActivityPoints(rows, [bin(0, 1, 100), bin(1, 2, 50)]);
    expect(points.at(-1)?.remainingPercent).toBe(88.5);
    expect(points.at(-1)?.provisional).toBe(true);
    expect(
      quotaActivityPoints(rows, [bin(0, 1, 100), bin(1, 2, 500)]).at(-1)?.remainingPercent,
    ).toBe(88.01);
    expect(
      quotaActivityPoints([sample(0, 90), sample(2, 90)], [bin(0, 2, 100)]).at(-1)
        ?.remainingPercent,
    ).toBe(90);
  });
  it("measures concentration by time rather than by the number of bins", () => {
    const uniform = visibleChartActivity(
      [bin(0, 1, 100), bin(1, 4, 300)],
      start,
      start + 4 * 3_600_000,
    );
    expect(uniform.averagePerHour).toBe(100);
    expect(uniform.busiestQuarterShare).toBe(0.25);
    const burst = visibleChartActivity(
      [bin(0, 1, 100), bin(1, 4, 0)],
      start,
      start + 4 * 3_600_000,
    );
    expect(burst.busiestQuarterShare).toBe(1);
    expect(burst.averagePerHour).toBe(25);
    expect(
      visibleChartActivity([bin(0, 1, null), bin(1, 4, 300)], start, start + 4 * 3_600_000)
        .busiestQuarterShare,
    ).toBeNull();
  });
  it("estimates quota consumed in a selected interval without crossing reset boundaries", () => {
    const points = quotaActivityPoints(
      [sample(0, 90), sample(2, 80)],
      [bin(0, 1, 90), bin(1, 2, 10)],
    );
    expect(estimatedQuotaDrop(points, start, start + 3_600_000)).toBe(9);
    expect(estimatedQuotaDrop(points, start + 1_800_000, start + 5_400_000)).toBe(5);
    expect(estimatedQuotaDrop(points, start - 1, start + 3_600_000)).toBeNull();
    expect(
      estimatedQuotaDrop(
        quotaActivityPoints([sample(0, 10), sample(2, 100)], []),
        start,
        start + 7_200_000,
      ),
    ).toBeNull();
  });
  it("allocates more of a measured drop to the expensive interval while preserving observations", () => {
    const points = quotaActivityPoints(
      [sample(0, 90), sample(2, 80)],
      [bin(0, 1, 90), bin(1, 2, 10)],
    );
    expect(points.map((p) => [p.remainingPercent, p.estimated])).toEqual([
      [90, false],
      [81, true],
      [80, false],
    ]);
  });
  it("holds the estimate flat through a priced idle interval", () => {
    const points = quotaActivityPoints(
      [sample(0, 90), sample(3, 80)],
      [bin(0, 1, 50), bin(1, 2, 0), bin(2, 3, 50)],
    );
    expect(points.map((p) => p.remainingPercent)).toEqual([90, 85, 85, 80]);
  });
  it("falls back to endpoints for missing, unpriced, or zero-cost activity", () => {
    for (const activity of [
      [],
      [bin(0, 1, 100)],
      [bin(0, 1, 100), bin(1, 2, null)],
      [bin(0, 2, 0)],
    ]) {
      expect(quotaActivityPoints([sample(0, 90), sample(2, 80)], activity)).toHaveLength(2);
    }
  });
  it("never distributes a reset increase or a timer change", () => {
    expect(
      quotaActivityPoints([sample(0, 80), sample(2, 100)], [bin(0, 1, 90), bin(1, 2, 10)]),
    ).toHaveLength(2);
    expect(
      quotaActivityPoints(
        [sample(0, 90), { ...sample(2, 80), resetsAt: at(190) }],
        [bin(0, 1, 90), bin(1, 2, 10)],
      ),
    ).toHaveLength(2);
  });
  it("bounds requests and brackets zooms with measured endpoints", () => {
    const rows = [sample(0, 100), sample(12, 90), sample(24, 80), sample(168, 10)];
    const full = chartActivityIntervals(rows, null);
    const zoom = chartActivityIntervals(rows, [start + 13 * 3_600_000, start + 15 * 3_600_000]);
    expect(full).toHaveLength(48);
    expect(zoom[0]?.sinceTime).toBe(at(0));
    expect(zoom.at(-1)?.untilTime).toBe(at(24));
    expect(zoom.every((row, i) => i === 0 || row.sinceTime === zoom[i - 1]!.untilTime)).toBe(true);
    expect(chartActivityIntervals([sample(0, 100)], null)).toEqual([]);
  });
  it("prorates visible costs and ranks the hottest interval by rate", () => {
    const value = visibleChartActivity(
      [bin(0, 1, 100), bin(1, 3, 120)],
      start + 0.5 * 3_600_000,
      start + 2 * 3_600_000,
    );
    expect(value.cost).toBe(110);
    expect(value.models).toEqual([["gpt-6-astra", 110]]);
    expect(value.peak?.perHour).toBe(100);
    expect(value.complete).toBe(true);
    expect(visibleChartActivity([bin(0, 1, null)], start, start + 3_600_000).complete).toBe(false);
  });
});
