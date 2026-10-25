import { describe, expect, it } from "vite-plus/test";
import { compareUsageBurn } from "./usageBurnComparison";
import type { ChartActivity } from "./usageChartActivity";

const hour = 3_600_000;
const start = Date.parse("2026-09-01T00:00:00Z");
const samples = Array.from({ length: 19 }, (_, index) => ({
  observedAt: new Date(start + index * hour).toISOString(),
  remainingPercent: 90 - index,
  resetsAt: new Date(start + 7 * 24 * hour).toISOString(),
}));
const activity: ChartActivity[] = Array.from({ length: 18 }, (_, index) => ({
  interval: {
    id: `hour-${index}`,
    sinceTime: new Date(start + index * hour).toISOString(),
    untilTime: new Date(start + (index + 1) * hour).toISOString(),
  },
  models: [
    {
      model: "gpt-6-sol",
      costUsd: index < 6 ? 1 : 10,
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
}));

describe("historical burn comparison", () => {
  it("scores non-overlapping six-hour predictions using only already completed costs", () => {
    const result = compareUsageBurn(samples, activity.slice(0, 12));
    expect(result.checks).toBe(2);
    expect(result.apiWins).toBe(1);
    expect(result.forecastWins).toBe(1);
    expect(result.apiMeanError).toBeGreaterThan(0);
    expect(result.forecastMeanError).toBeGreaterThan(0);
    expect(
      compareUsageBurn(
        samples,
        activity.map((bin, index) =>
          index >= 12
            ? {
                ...bin,
                models: bin.models!.map((model) => ({ ...model, costUsd: 100_000 })),
              }
            : bin,
        ),
      ),
    ).toEqual(result);
  });

  it("withholds comparisons across missing prices, missing future readings, and resets", () => {
    expect(
      compareUsageBurn(
        samples,
        activity.map((bin) => ({ ...bin, models: null })),
      ),
    ).toMatchObject({ checks: 0 });
    expect(compareUsageBurn(samples.slice(0, 12), activity)).toMatchObject({ checks: 0 });
    expect(
      compareUsageBurn(
        samples.map((sample, index) =>
          index >= 6
            ? { ...sample, resetsAt: new Date(start + 8 * 24 * hour).toISOString() }
            : sample,
        ),
        activity,
      ),
    ).toMatchObject({ checks: 0 });
  });
});
