import { describe, expect, it } from "vite-plus/test";
import { quotaForecast } from "./usageQuotaForecast.ts";
import { quotaMonitoringSamples } from "./usageQuota.ts";

const reset = "2026-09-06T00:00:00.000Z";
const sample = (observedAt: string, remainingPercent: number, resetsAt = reset) => ({
  observedAt,
  remainingPercent,
  resetsAt,
});

describe("Codex weekly forecast", () => {
  it("forecasts from the real weekly window even with a single observation", () => {
    const at = "2026-08-31T00:00:00.000Z";
    const result = quotaForecast([sample(at, 80)], Date.parse(at))!;
    expect(result.expectedPercentPerDay).toBe(20);
    expect(result.exhaustionAt).toBe("2026-09-04T00:00:00.000Z");
    expect(result.recommendedPercentPerDay).toBeCloseTo(77 / 6);
    expect(result.paceDelta).toBeCloseTo(20 - 100 / 7);
    expect(result.projectionEndX).toBeCloseTo(4 / 6);
    expect(result.exhaustsBeforeReset).toBe(true);
  });
  it("keeps clock age separate from the percentage measurement", () => {
    const at = "2026-08-31T00:00:00.000Z";
    const a = quotaForecast([sample(at, 80)], Date.parse(at))!;
    const b = quotaForecast([sample(at, 80)], Date.parse(at) + 16 * 60_000)!;
    expect(b.stale).toBe(true);
    expect(b.exhaustionAt).toBe(a.exhaustionAt);
    expect(b.usedPercent).toBe(a.usedPercent);
    expect(b.resetInMs).toBeLessThan(a.resetInMs);
    expect(quotaForecast([sample(at, 80)], Date.parse(reset))!.stale).toBe(true);
  });
  it("does not invent a run-out time at zero burn", () => {
    const at = "2026-08-31T00:00:00.000Z";
    const result = quotaForecast([sample(at, 100)], Date.parse(at))!;
    expect(result.exhaustionAt).toBeNull();
    expect(result.remainingAtReset).toBe(100);
  });
  it("does not treat rounded flat readings as zero burn or a reset as negative usage", () => {
    const at = "2026-08-31T00:05:00.000Z";
    const result = quotaForecast(
      [
        sample("2026-08-30T23:55:00.000Z", 5),
        sample("2026-08-31T00:00:00.000Z", 80),
        sample(at, 80),
      ],
      Date.parse(at),
    )!;
    expect(result.expectedPercentPerDay).toBeGreaterThan(19);
    expect(result.points).toHaveLength(2);
  });
  it("does not let earlier monitoring runs skew current pace", () => {
    const at = "2026-08-31T00:00:00.000Z";
    const result = quotaForecast(
      [
        sample("2026-08-23T00:00:00.000Z", 100, "2026-08-30T00:00:00.000Z"),
        sample("2026-08-24T00:00:00.000Z", 90, "2026-08-30T00:00:00.000Z"),
        sample("2026-08-30T00:00:00.000Z", 100),
        sample(at, 80),
      ],
      Date.parse(at),
    )!;
    expect(result.expectedPercentPerDay).toBe(20);
    expect(result.points).toHaveLength(2);
  });
  it("separates total cycle usage from what the monitor actually saw", () => {
    const at = "2026-08-31T02:00:00.000Z";
    const result = quotaForecast(
      [sample("2026-08-31T00:00:00.000Z", 83), sample(at, 81)],
      Date.parse(at),
    )!;
    expect(result.usedPercent).toBe(19);
    expect(result.monitoredUsedPercent).toBe(2);
    expect(result.usedBeforeMonitoring).toBe(17);
  });
  it("plans to an earlier announcement without changing the account clock or balance", () => {
    const at = "2026-08-31T00:00:00.000Z";
    const announced = "2026-08-31T01:00:00.000Z";
    const result = quotaForecast([sample(at, 81)], Date.parse(at), 3, announced)!;
    expect(result.usesAnnouncement).toBe(true);
    expect(result.planningResetAt).toBe(announced);
    expect(result.latest.resetsAt).toBe(reset);
    expect(result.usedPercent).toBe(19);
    expect(result.latest.remainingPercent).toBe(81);
    expect(result.recommendedPercentPerDay / 24).toBe(78);
    expect(result.remainingAtReset).toBeGreaterThan(80);
    expect(result.exhaustsBeforeReset).toBe(false);
  });
  it.each(["2026-08-30T00:00:00Z", "2026-09-07T00:00:00Z", "invalid"])(
    "ignores an expired, later or invalid announcement: %s",
    (announced) => {
      const at = "2026-08-31T00:00:00.000Z";
      const result = quotaForecast([sample(at, 81)], Date.parse(at), 3, announced)!;
      expect(result.usesAnnouncement).toBe(false);
      expect(result.planningResetAt).toBe(reset);
    },
  );
  it("retains new reset observations but excludes history before a monitoring gap", () => {
    const old = sample("2026-07-21T00:00:00Z", 12, "2026-07-25T00:00:00Z");
    const recent = [
      sample("2026-08-30T20:00:00Z", 83),
      sample("2026-08-30T22:00:00Z", 81),
      sample("2026-08-31T01:00:00Z", 100, "2026-09-07T01:00:00Z"),
    ];
    expect(quotaMonitoringSamples([old, ...recent])).toEqual(recent);
    const result = quotaForecast([old, ...recent], Date.parse(recent[2]!.observedAt))!;
    expect(result.usedPercent).toBe(0);
    expect(result.monitoredUsedPercent).toBe(0);
    expect(result.expectedPercentPerDay).toBe(0);
  });
});
