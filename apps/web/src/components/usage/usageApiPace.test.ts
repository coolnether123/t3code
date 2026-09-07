import { describe, expect, it } from "vite-plus/test";
import { quotaForecast } from "@t3tools/shared/usageQuotaForecast";
import { quotaIntervals, quotaPeriods } from "@t3tools/shared/usageQuota";
import {
  apiCostPace,
  apiPaceInterval,
  manualResetScenario,
  usageRunwayPlan,
  type ApiPaceInput,
} from "./usageApiPace";

const now = Date.parse("2026-09-05T12:00:00Z");
const samples = [
  {
    observedAt: "2026-09-05T00:00:00.000Z",
    remainingPercent: 70,
    resetsAt: "2026-09-05T15:00:00.000Z",
  },
  {
    observedAt: new Date(now).toISOString(),
    remainingPercent: 50,
    resetsAt: "2026-09-05T15:00:00.000Z",
  },
];
const forecast = quotaForecast(samples, now)!;
const interval = apiPaceInterval(quotaIntervals(quotaPeriods(samples)).at(-1))!;
const input: ApiPaceInput = {
  interval,
  remainingValueUsd: 50,
  models: [
    {
      model: "gpt-5.6-luna",
      costUsd: 60,
      unpricedRecords: 0,
      totals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 50e6,
        reasoningTokens: 0,
      },
    },
  ],
};

describe("API cost pace", () => {
  it("uses the most recent six hours and respects a new cycle's start", () => {
    expect(interval.sinceTime).toBe("2026-09-05T06:00:00.000Z");
    const newCycle = quotaPeriods([
      { ...samples[0]!, observedAt: "2026-09-05T10:00:00.000Z" },
      samples[1]!,
    ]).at(-1);
    expect(apiPaceInterval(quotaIntervals([newCycle!]).at(-1))?.sinceTime).toBe(
      "2026-09-05T10:00:00.000Z",
    );
    expect(apiPaceInterval(quotaIntervals(quotaPeriods([samples[1]!])).at(-1))).toBeNull();
  });
  it("divides the balance by hourly dollars, including elapsed idle time", () => {
    const result = apiCostPace(forecast, input, now)!;
    expect(result.usdPerHour).toBe(10);
    expect(result.exhaustionInMs).toBe(5 * 3_600_000);
    expect(result.exhaustionAt).toBe("2026-09-05T17:00:00.000Z");
    expect(result.remainingAtResetUsd).toBe(20);
    expect(result.projectionEndPercent).toBe(20);
    expect(result.projectionEndX).toBe(1);
  });
  it("clips at exhaustion and does not count unobserved time as measured spending", () => {
    const result = apiCostPace(forecast, { ...input, remainingValueUsd: 10 }, now + 300_000)!;
    expect(result.exhaustionInMs).toBe(55 * 60_000);
    expect(result.usdPerHour).toBe(10);
    expect(result.projectionEndX).toBeCloseTo(13 / 15);
    expect(result.projectionEndPercent).toBe(0);
  });
  it("draws a flat line for a complete zero-cost interval without inventing an exhaustion date", () => {
    const result = apiCostPace(forecast, { ...input, models: [] }, now)!;
    expect(result.usdPerHour).toBe(0);
    expect(result.exhaustionAt).toBeNull();
    expect(result.projectionEndPercent).toBe(50);
    const plan = usageRunwayPlan(result, "2026-09-06T12:00:00.000Z", now)!;
    expect(plan.noUsageHours).toBe(0);
    expect(plan.exhaustionAt).toBeNull();
    expect(plan.withinTolerance).toBe(true);
  });
  it("withholds stale, incomplete, unpriced, or mismatched evidence", () => {
    expect(apiCostPace({ ...forecast, stale: true }, input, now)).toBeNull();
    expect(apiCostPace(forecast, { ...input, models: null }, now)).toBeNull();
    expect(apiCostPace(forecast, { ...input, remainingValueUsd: null }, now)).toBeNull();
    expect(
      apiCostPace(
        forecast,
        { ...input, models: [{ ...input.models![0]!, unpricedRecords: 1 }] },
        now,
      ),
    ).toBeNull();
    expect(
      apiCostPace(
        forecast,
        { ...input, interval: { ...interval, untilTime: samples[0]!.observedAt } },
        now,
      ),
    ).toBeNull();
  });
  it("calculates quiet time and the burn rate that reaches zero before reset", () => {
    const pace = apiCostPace(forecast, input, now)!;
    const plan = usageRunwayPlan(pace, "2026-09-06T12:00:00.000Z", now)!;
    expect(plan.noUsageHours).toBe(19);
    expect(plan.exhaustionAt).toBe("2026-09-05T17:00:00.000Z");
    expect(plan.targetAt).toBe("2026-09-06T00:00:00.000Z");
    expect(plan.targetUsdPerHour).toBeCloseTo(50 / 12);
    expect(plan.withinTolerance).toBe(false);
    const safe = usageRunwayPlan(pace, "2026-09-05T23:00:00.000Z", now)!;
    expect(safe.noUsageHours).toBe(6);
    expect(safe.withinTolerance).toBe(true);
  });
  it("accounts for measured spending since the last reading", () => {
    const pace = apiCostPace(forecast, input, now)!;
    const plan = usageRunwayPlan(pace, "2026-09-06T12:00:00.000Z", now + 3_600_000)!;
    expect(plan.targetUsdPerHour).toBeCloseTo(40 / 11);
    expect(plan.exhaustionAt).toBe("2026-09-05T17:00:00.000Z");
  });
  it("simulates one manual reset as a new window instead of extending the old timer", () => {
    const pace = apiCostPace(forecast, input, now)!;
    const scenario = manualResetScenario(
      pace,
      { availableCount: 3, verified: true, expiries: ["2026-09-21T08:10:23.000Z"] },
      now,
      "2026-09-06T12:00:00.000Z",
    )!;
    expect(scenario.remainingCount).toBe(2);
    expect(scenario.fullCycleValueUsd).toBe(100);
    expect(scenario.hoursAtBurn).toBe(10);
    expect(scenario.windowEndsAt).toBe("2026-09-12T17:00:00.000Z");
    expect(scenario.noUsageMs).toBe(158 * 3_600_000);
    expect(scenario.expiryAllowsUse).toBe(true);
  });
  it("does not claim a manual credit is usable after its expiry or without expiry data", () => {
    const pace = apiCostPace(forecast, input, now)!;
    expect(
      manualResetScenario(
        pace,
        { availableCount: 1, verified: true, expiries: ["2026-09-05T16:00:00.000Z"] },
        now,
        "2026-09-06T12:00:00.000Z",
      )!.expiryAllowsUse,
    ).toBe(false);
    expect(
      manualResetScenario(
        pace,
        { availableCount: 1, verified: true },
        now,
        "2026-09-06T12:00:00.000Z",
      )!.expiryAllowsUse,
    ).toBeNull();
  });
  it("keeps a full-cycle scenario unknown when no positive quota percentage can calibrate it", () => {
    const pace = apiCostPace(
      { ...forecast, latest: { ...forecast.latest, remainingPercent: 0 } },
      input,
      now,
    )!;
    const scenario = manualResetScenario(
      pace,
      { availableCount: 1, verified: true },
      now,
      "2026-09-06T12:00:00.000Z",
    )!;
    expect(scenario.fullCycleValueUsd).toBeNull();
    expect(scenario.hoursAtBurn).toBeNull();
    expect(scenario.noUsageMs).toBeNull();
  });
  it("does not create a manual-reset scenario when automatic reset arrives first", () => {
    const pace = apiCostPace(forecast, input, now)!;
    expect(
      manualResetScenario(
        pace,
        { availableCount: 1, verified: true },
        now,
        "2026-09-05T15:00:00.000Z",
      ),
    ).toBeNull();
  });
});
