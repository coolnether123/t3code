import { describe, expect, it } from "vite-plus/test";
import { quotaPeriods } from "@t3tools/shared/usageQuota";
import { compareQuotaCycles, cycleCostStats } from "./cycleComparisonMath";

const samples = [
  {
    observedAt: "2026-09-01T00:00:00.000Z",
    resetsAt: "2026-09-08T00:00:00.000Z",
    remainingPercent: 80,
  },
  {
    observedAt: "2026-09-01T02:00:00.000Z",
    resetsAt: "2026-09-08T00:00:00.000Z",
    remainingPercent: 70,
  },
  {
    observedAt: "2026-09-01T04:00:00.000Z",
    resetsAt: "2026-09-08T00:00:00.000Z",
    remainingPercent: 60,
  },
  {
    observedAt: "2026-09-02T00:00:00.000Z",
    resetsAt: "2026-09-09T00:00:00.000Z",
    remainingPercent: 100,
  },
  {
    observedAt: "2026-09-02T01:00:00.000Z",
    resetsAt: "2026-09-09T00:00:00.000Z",
    remainingPercent: 92,
  },
];

describe("equal-duration cycle comparisons", () => {
  it("uses observed drops and exact equal cost windows, without assuming the first balance was 100", () => {
    const [previous, current] = quotaPeriods(samples);
    const result = compareQuotaCycles(current!, previous!, samples)!;
    expect(result.hours).toBe(1);
    expect(result.selected.used).toBe(8);
    expect(result.baseline.used).toBe(5);
    expect(result.difference).toBe(3);
    expect(result.baseline.interpolated).toBe(true);
    expect(result.baseline.interval.untilTime).toBe("2026-09-01T01:00:00.000Z");
    expect(result.selected.interval.untilTime).toBe("2026-09-02T01:00:00.000Z");
    expect(result.baseline.points.at(-1)).toEqual({ elapsed: 3_600_000, used: 5 });
  });
  it("clips a longer selected cycle to the earlier cycle's observed duration", () => {
    const longer = [
      ...samples,
      { ...samples[4]!, observedAt: "2026-09-02T06:00:00.000Z", remainingPercent: 52 },
    ];
    const [previous, current] = quotaPeriods(longer);
    const result = compareQuotaCycles(current!, previous!, longer)!;
    expect(result.hours).toBe(4);
    expect(result.selected.used).toBe(32);
    expect(result.baseline.used).toBe(20);
    expect(result.selected.interval.untilTime).toBe("2026-09-02T04:00:00.000Z");
    expect(result.selected.points.every((point) => point.elapsed <= result.duration)).toBe(true);
  });
  it("does not compare a cycle with only one reading", () => {
    const [previous, current] = quotaPeriods(samples.slice(0, 4));
    expect(compareQuotaCycles(current!, previous!, samples.slice(0, 4))).toBeNull();
  });
  it("keeps unpriced and missing costs unknown and includes idle time in rates", () => {
    const models = [
      {
        model: "gpt-6-astra",
        costUsd: 20,
        unpricedRecords: 0,
        totals: {
          uncachedInputTokens: 10,
          cachedInputTokens: 80,
          cacheCreationTokens: 10,
          outputTokens: 40,
          reasoningTokens: 20,
        },
      },
    ];
    expect(cycleCostStats(models, 4)).toEqual({
      cost: 20,
      perHour: 5,
      cachePercent: 80,
      outputPerHour: 10,
    });
    expect(cycleCostStats(null, 4)).toBeNull();
    expect(cycleCostStats([{ ...models[0]!, unpricedRecords: 1 }], 4)).toBeNull();
    expect(cycleCostStats([], 4)).toEqual({
      cost: 0,
      perHour: 0,
      cachePercent: null,
      outputPerHour: 0,
    });
  });
});
