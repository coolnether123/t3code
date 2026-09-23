import type { UsageQuotaInterval, UsageQuotaSample } from "@t3tools/contracts";
import type { QuotaPeriod } from "@t3tools/shared/usageQuota";
import type { monitoredModels } from "./usageTokenBudget";

const HOUR = 3_600_000;

/** Compare equal observed durations, without assuming monitoring began at the reset. */
export function compareQuotaCycles(
  current: QuotaPeriod,
  previous: QuotaPeriod,
  samples: readonly UsageQuotaSample[],
) {
  const duration = Math.min(
    Date.parse(current.last.observedAt) - Date.parse(current.first.observedAt),
    Date.parse(previous.last.observedAt) - Date.parse(previous.first.observedAt),
  );
  if (duration <= 0) return null;
  const series = (period: QuotaPeriod) => {
    const start = Date.parse(period.first.observedAt);
    const end = start + duration;
    const readings = samples
      .filter(
        (sample) =>
          sample.observedAt >= period.first.observedAt &&
          sample.observedAt <= period.last.observedAt,
      )
      .toSorted((a, b) => a.observedAt.localeCompare(b.observedAt));
    const before =
      readings.findLast((sample) => Date.parse(sample.observedAt) <= end) ?? period.first;
    const after = readings.find((sample) => Date.parse(sample.observedAt) > end);
    const fraction = after
      ? (end - Date.parse(before.observedAt)) /
        (Date.parse(after.observedAt) - Date.parse(before.observedAt))
      : 0;
    const balance =
      before.remainingPercent +
      fraction * ((after?.remainingPercent ?? before.remainingPercent) - before.remainingPercent);
    const points = readings
      .filter((sample) => Date.parse(sample.observedAt) < end)
      .map((sample) => ({
        elapsed: Date.parse(sample.observedAt) - start,
        used: period.first.remainingPercent - sample.remainingPercent,
      }));
    const used = period.first.remainingPercent - balance;
    points.push({ elapsed: duration, used });
    const interval: UsageQuotaInterval = {
      id: `compare:${period.id}:${duration}`,
      sinceTime: period.first.observedAt,
      untilTime: new Date(end).toISOString(),
    };
    return { points, used, interval, interpolated: Date.parse(before.observedAt) !== end };
  };
  const selected = series(current);
  const baseline = series(previous);
  return {
    duration,
    hours: duration / HOUR,
    selected,
    baseline,
    difference: selected.used - baseline.used,
  };
}

/** Keep missing or unpriced model totals out of comparative claims. */
export function cycleCostStats(models: ReturnType<typeof monitoredModels>, hours: number) {
  if (!models || hours <= 0 || models.some((model) => model.unpricedRecords > 0)) return null;
  const cost = models.reduce((sum, model) => sum + model.costUsd, 0);
  const cached = models.reduce((sum, model) => sum + model.totals.cachedInputTokens, 0);
  const input = models.reduce(
    (sum, model) =>
      sum +
      model.totals.uncachedInputTokens +
      model.totals.cachedInputTokens +
      model.totals.cacheCreationTokens,
    0,
  );
  const output = models.reduce((sum, model) => sum + model.totals.outputTokens, 0);
  return {
    cost,
    perHour: cost / hours,
    cachePercent: input > 0 ? (100 * cached) / input : null,
    outputPerHour: output / hours,
  };
}
