import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
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

describe("recent Codex burn projection", () => {
  const now = Date.parse("2026-08-31T02:00:00Z");
  const recent = (remaining: readonly number[], step = 5) =>
    remaining.map((value, index) =>
      sample(
        DateTime.formatIso(
          DateTime.makeUnsafe(now - (remaining.length - index - 1) * step * 60_000),
        ),
        value,
      ),
    );

  it("fits the last 30 minutes without importing an older burn rate", () => {
    const result = quotaForecast(
      [sample("2026-08-30T03:00:00Z", 100), ...recent([90, 89, 88, 87, 86, 85, 84])],
      now,
    )!;
    expect(result.recentPace).toMatchObject({
      windowMinutes: 30,
      sampleCount: 7,
      percentPerHour: 12,
    });
    expect(result.recentPace!.percentPerHour).not.toBeCloseTo(result.expectedPercentPerDay / 24);
    expect(result.latest.remainingPercent).toBe(84);
    expect(result.usedPercent).toBe(16);
  });

  it("shows a conditional flat line for rounded flat readings", () => {
    const result = quotaForecast(recent([81, 81, 81, 81, 81, 81, 81]), now)!;
    expect(result.recentPace).toMatchObject({
      percentPerHour: 0,
      remainingAtReset: 81,
      exhaustionAt: null,
      projectionEndX: 1,
    });
    expect(result.expectedPercentPerDay).toBeGreaterThan(0);
    expect(result.usedPercent).toBe(19);
  });

  it("waits for enough distinct observations instead of using a five-minute burst", () => {
    const rows = recent([81, 80]);
    expect(quotaForecast(rows, now)!.recentPace).toBeNull();
    expect(quotaForecast([...rows, ...rows, ...rows], now)!.recentPace).toBeNull();
    expect(quotaForecast(recent([83, 82, 81, 80], 2), now)!.recentPace).toBeNull();
  });

  it("excludes resets and long gaps from the recent fit", () => {
    expect(quotaForecast(recent([85, 84, 83, 82], 15), now)!.recentPace).toBeNull();
    expect(quotaForecast(recent([20, 19, 18, 17, 100, 99, 98]), now)!.recentPace).toBeNull();
    const rows = recent([85, 84, 83, 82, 81, 80, 79]);
    rows[4] = { ...rows[4]!, resetsAt: "2026-09-07T00:00:00Z" };
    rows[5] = { ...rows[5]!, resetsAt: "2026-09-07T00:00:00Z" };
    rows[6] = { ...rows[6]!, resetsAt: "2026-09-07T00:00:00Z" };
    expect(quotaForecast(rows, now)!.recentPace).toBeNull();
  });

  it("withholds a recent forecast when readings are stale or in the future", () => {
    const rows = recent([84, 83, 82, 81]);
    expect(quotaForecast(rows, now + 16 * 60_000)!.recentPace).toBeNull();
    expect(quotaForecast(rows, now - 1)!.recentPace).toBeNull();
    expect(quotaForecast(rows, Date.parse(reset))!.recentPace).toBeNull();
  });

  it("uses the current planning deadline and clamps exhausted usage to zero", () => {
    const deadline = DateTime.formatIso(DateTime.makeUnsafe(now + 3_600_000));
    const result = quotaForecast(recent([84, 83, 82, 81]), now, 3, deadline)!;
    expect(result.recentPace!.remainingAtReset).toBeCloseTo(69);
    expect(result.recentPace!.exhaustsBeforeReset).toBe(false);
    const low = quotaForecast(recent([6, 5, 4, 3]), now, 3, deadline)!.recentPace!;
    expect(low.remainingAtReset).toBe(0);
    expect(low.exhaustionInMs).toBeCloseTo(15 * 60_000);
    expect(low.exhaustsBeforeReset).toBe(true);
    expect(low.projectionEndX).toBeCloseTo(0.4);
  });

  it("uses every timestamp to smooth uneven sampling and reports the actual window", () => {
    const rows = [0, 4, 9, 15, 20].map((minute) =>
      sample(
        DateTime.formatIso(DateTime.makeUnsafe(now - (20 - minute) * 60_000)),
        90 - minute / 5,
      ),
    );
    const result = quotaForecast(rows, now)!.recentPace!;
    expect(result.windowMinutes).toBe(20);
    expect(result.sampleCount).toBe(5);
    expect(result.percentPerHour).toBeCloseTo(12);
  });
});
