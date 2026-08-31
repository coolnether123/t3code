import type { UsageQuotaSample } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { quotaHistoryPoints, quotaMonitoringSamples, quotaPeriods } from "./usageQuota.ts";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
export const QUOTA_STALE_MS = 15 * 60_000;

/** Current-cycle pace. A public announcement changes planning, never the measured balance. */
export function quotaForecast(
  samples: readonly UsageQuotaSample[],
  now: number,
  reserve = 3,
  announcedResetAt?: string,
) {
  const monitored = quotaMonitoringSamples(samples);
  const periods = quotaPeriods(monitored);
  const period = periods.at(-1);
  if (!period) return null;
  const latest = period.last;
  const observed = Date.parse(latest.observedAt);
  const weeklyReset = Date.parse(latest.resetsAt);
  const announcement = announcedResetAt === undefined ? NaN : Date.parse(announcedResetAt);
  const usesAnnouncement = announcement > now && announcement < weeklyReset;
  const reset = usesAnnouncement ? announcement : weeklyReset;
  const windowStart = weeklyReset - WEEK;
  const start = Date.parse(period.first.observedAt);
  const daysLeft = Math.max((reset - observed) / DAY, 0);
  const elapsedDays = Math.max((observed - windowStart) / DAY, 1 / 24);
  const used = 100 - latest.remainingPercent;
  const windowRate = used / elapsedDays;
  const monitoredDays = (observed - start) / DAY;
  // Whole-percent readings over a few minutes are not a reliable burn rate.
  const recentRate =
    monitoredDays >= 1 / 24 && period.usedPercentagePoints >= 1
      ? period.usedPercentagePoints / monitoredDays
      : null;
  const expectedRate = recentRate === null ? windowRate : 0.7 * recentRate + 0.3 * windowRate;
  const remainingAtReset = Math.max(latest.remainingPercent - expectedRate * daysLeft, 0);
  const exhaustion =
    latest.remainingPercent === 0
      ? observed
      : expectedRate > 0.0001
        ? observed + (latest.remainingPercent / expectedRate) * DAY
        : null;
  const exhaustionAt =
    exhaustion !== null && exhaustion - observed <= 100_000 * DAY
      ? DateTime.formatIso(DateTime.makeUnsafe(exhaustion))
      : null;
  const x = (time: number) => Math.max(0, Math.min(1, (time - start) / Math.max(reset - start, 1)));
  const currentSamples = monitored.filter((sample) => sample.observedAt >= period.first.observedAt);
  return {
    latest,
    first: period.first,
    monitoredUsedPercent: period.usedPercentagePoints,
    usedBeforeMonitoring: 100 - period.first.remainingPercent,
    usesAnnouncement,
    planningResetAt: DateTime.formatIso(DateTime.makeUnsafe(reset)),
    startsAt: DateTime.formatIso(DateTime.makeUnsafe(start)),
    stale: now - observed > QUOTA_STALE_MS || now < observed || now >= weeklyReset,
    resetInMs: Math.max(reset - now, 0),
    exhaustionInMs: exhaustion === null ? null : Math.max(exhaustion - now, 0),
    exhaustionAt,
    exhaustsBeforeReset: exhaustion !== null && exhaustion < reset,
    usedPercent: used,
    linearUsedPercent: Math.max(0, Math.min(100, ((observed - windowStart) / WEEK) * 100)),
    paceDelta: used - Math.max(0, Math.min(100, ((observed - windowStart) / WEEK) * 100)),
    expectedPercentPerDay: expectedRate,
    recommendedPercentPerDay:
      daysLeft > 0 ? Math.max(latest.remainingPercent - reserve, 0) / daysLeft : 0,
    remainingAtReset,
    reserve,
    observationX: x(observed),
    projectionEndX: x(Math.min(exhaustion ?? reset, reset)),
    projectionEndPercent: remainingAtReset,
    points: quotaHistoryPoints(currentSamples).map((sample) => ({
      ...sample,
      x: x(Date.parse(sample.observedAt)),
    })),
  };
}

export type QuotaForecast = NonNullable<ReturnType<typeof quotaForecast>>;

export function quotaDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
