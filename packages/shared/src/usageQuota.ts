import type {
  UsageQuotaInterval,
  UsageQuotaSample,
  UsageSourceFingerprint,
  UsageSummary,
  UsageSummaryInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Start a new monitoring run after a day without readings; retain the source history. */
export function quotaMonitoringSamples(samples: readonly UsageQuotaSample[]) {
  const sorted = [...samples].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  let start = 0;
  for (let index = 1; index < sorted.length; index++) {
    if (
      Date.parse(sorted[index]!.observedAt) - Date.parse(sorted[index - 1]!.observedAt) >
      DAY_MS
    ) {
      start = index;
    }
  }
  return sorted.slice(start);
}

export interface QuotaPeriod {
  readonly id: string;
  readonly first: UsageQuotaSample;
  readonly last: UsageQuotaSample;
  readonly next: UsageQuotaSample | null;
  readonly sampleCount: number;
  readonly resetKind: "scheduled" | "unexpected" | "ambiguous" | "unobserved";
  readonly usedPercentagePoints: number;
  readonly observationGapMs: number | null;
}

/** A changed reset clock alone is not proof that a reset was used. */
export function quotaPeriods(samples: readonly UsageQuotaSample[]): readonly QuotaPeriod[] {
  const sorted = [...samples].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const groups: UsageQuotaSample[][] = [];
  for (const sample of sorted) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (
      !group ||
      !previous ||
      sample.remainingPercent > previous.remainingPercent ||
      Math.abs(Date.parse(sample.resetsAt) - Date.parse(previous.resetsAt)) > MINUTE_MS
    ) {
      groups.push([sample]);
    } else if (sample.observedAt !== previous.observedAt) group.push(sample);
  }
  return groups.slice(-64).map((group, index, retained) => {
    const first = group[0]!;
    const last = group.at(-1)!;
    const next = retained[index + 1]?.[0] ?? null;
    const observationGapMs =
      next === null ? null : Date.parse(next.observedAt) - Date.parse(last.observedAt);
    let resetKind: QuotaPeriod["resetKind"] = "unobserved";
    if (next !== null) {
      const reset = Date.parse(last.resetsAt);
      if (
        Date.parse(next.observedAt) >= reset &&
        Date.parse(last.observedAt) <= reset &&
        Date.parse(next.resetsAt) > reset + MINUTE_MS
      )
        resetKind = "scheduled";
      else if (
        Date.parse(next.observedAt) < reset &&
        next.remainingPercent > last.remainingPercent + 2
      ) {
        resetKind = "unexpected";
      } else resetKind = "ambiguous";
    }
    return {
      id: first.observedAt,
      first,
      last,
      next,
      resetKind,
      observationGapMs,
      sampleCount: group.length,
      usedPercentagePoints: first.remainingPercent - last.remainingPercent,
    };
  });
}

export function quotaIntervals(periods: readonly QuotaPeriod[]): readonly UsageQuotaInterval[] {
  return periods
    .filter((period) => period.first.observedAt < period.last.observedAt)
    .map((period) => ({
      id: period.id,
      sinceTime: period.first.observedAt,
      untilTime: period.last.observedAt,
    }));
}

/** UTC padding avoids clipping observations at a client's local day boundary. */
export function quotaCostWindow(
  intervals: readonly UsageQuotaInterval[],
): UsageSummaryInput | null {
  const first = intervals[0];
  const last = intervals.at(-1);
  if (!first || !last) return null;
  return {
    sinceDay: DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(first.sinceTime) - 2 * DAY_MS),
    ).slice(0, 10) as UsageSummaryInput["sinceDay"],
    untilDay: DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(last.untilTime) + 2 * DAY_MS),
    ).slice(0, 10) as UsageSummaryInput["untilDay"],
    timeZone: "UTC",
    quotaIntervals: intervals,
  };
}

export interface QuotaEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly summary: UsageSummary | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

export interface QuotaValue {
  readonly cachedAt?: string;
  readonly costUsd: number | null;
  readonly usdPerPercentagePoint: number | null;
  readonly remainingValueUsd: number | null;
  readonly unusedValueUsd: number | null;
  readonly reason: string | null;
}

export interface QuotaValueSnapshot {
  readonly key: string;
  readonly period: QuotaPeriod;
  readonly value: QuotaValue;
  readonly calculatedAt: string;
}

/** A complete calculation belongs to one tracker, selection, and exact observed period. */
export function quotaValueSnapshots(
  trackerId: string | undefined,
  periods: readonly QuotaPeriod[],
  environments: readonly QuotaEnvironment[],
): readonly QuotaValueSnapshot[] {
  const selection = environments
    .map((environment) => ({
      id: environment.environmentId,
      sources:
        environment.summary?.sources
          .filter((source) => source.fingerprint.provider === "codex")
          .map((source) => sourceKey(source.fingerprint))
          .sort() ?? [],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const calculatedAt = DateTime.formatIso(DateTime.nowUnsafe());
  return periods.map((period) => ({
    key: JSON.stringify([trackerId, selection, period]),
    period,
    value: quotaValue(period, environments),
    calculatedAt,
  }));
}

export function retainQuotaValueSnapshots(
  previous: ReadonlyMap<string, QuotaValueSnapshot>,
  current: readonly QuotaValueSnapshot[],
): ReadonlyMap<string, QuotaValueSnapshot> {
  const complete = current.filter((snapshot) => snapshot.value.costUsd !== null);
  if (complete.every((snapshot) => previous.get(snapshot.key) === snapshot)) return previous;
  const next = new Map(previous);
  for (const snapshot of complete) {
    next.delete(snapshot.key);
    next.set(snapshot.key, snapshot);
  }
  while (next.size > 128) next.delete(next.keys().next().value!);
  return next;
}

/** A labeled past calculation, never a conversion of incomplete costs. */
export function quotaValueWithSnapshot(
  current: QuotaValueSnapshot,
  cached: ReadonlyMap<string, QuotaValueSnapshot>,
): QuotaValue {
  if (current.value.costUsd !== null) return current.value;
  const previous = cached.get(current.key);
  if (!previous) return current.value;
  return {
    ...previous.value,
    cachedAt: previous.calculatedAt,
    reason: `Showing the last complete calculation. ${current.value.reason ?? "Updated costs are not yet available."}`,
  };
}

function sourceKey(source: UsageSourceFingerprint): string {
  return JSON.stringify([source.hostId, source.provider, source.resolvedHomePath, source.volumeId]);
}

/** Estimates assume selected transcripts cover one account; percentages are never summed. */
export function quotaValue(
  period: QuotaPeriod,
  environments: readonly QuotaEnvironment[],
): QuotaValue {
  const unavailable = (reason: string): QuotaValue => ({
    costUsd: null,
    usdPerPercentagePoint: null,
    remainingValueUsd: null,
    unusedValueUsd: null,
    reason,
  });
  if (environments.length === 0)
    return unavailable("Select the computers containing this account's history.");
  if (period.first.observedAt === period.last.observedAt)
    return unavailable("Waiting for the next tracker reading to measure usage.");
  const seen = new Set<string>();
  let costUsd = 0;
  let records = 0;
  let unpricedRecords = 0;
  for (const environment of [...environments].sort((a, b) =>
    a.environmentId.localeCompare(b.environmentId),
  )) {
    const { summary, label } = environment;
    if (environment.error) {
      return unavailable(`${label} could not report usage. Refresh to retry.`);
    }
    if (environment.isPending && !summary) {
      return unavailable(`${label} is still reading Codex transcripts.`);
    }
    if (!summary) {
      return unavailable(`${label} has not supplied a complete usage result.`);
    }
    if (summary.quotaCosts === undefined)
      return unavailable(`${label} needs a server with reset-history support.`);
    const sources = summary.sources.filter(
      (source) => source.fingerprint.provider === "codex" && source.status !== "missing",
    );
    if (sources.length === 0)
      return unavailable(`${label} has no readable Codex transcript source.`);
    for (const source of sources) {
      if (source.status !== "ok") return unavailable(`${label}'s transcript scan is incomplete.`);
      const key = sourceKey(source.fingerprint);
      if (seen.has(key)) continue;
      const row = summary.quotaCosts.find(
        (candidate) =>
          candidate.intervalId === period.id && sourceKey(candidate.fingerprint) === key,
      );
      if (!row) return unavailable(`${label} has not supplied costs for this observed period.`);
      if (!row.complete) return unavailable(`${label}'s matching transcript scan is incomplete.`);
      if (!Number.isFinite(row.costUsd) || row.costUsd < 0)
        return unavailable("A cost result is invalid.");
      seen.add(key);
      costUsd += row.costUsd;
      records += row.records;
      unpricedRecords += row.unpricedRecords;
    }
  }
  if (records === 0)
    return unavailable("No matching transcript usage was found. Missing history is not zero cost.");
  if (unpricedRecords > 0)
    return unavailable("Some matching usage has no model price. Dollar estimates are withheld.");
  const measured: QuotaValue = {
    costUsd,
    usdPerPercentagePoint: null,
    remainingValueUsd: null,
    unusedValueUsd: null,
    reason: null,
  };
  if (period.usedPercentagePoints < 5)
    return {
      ...measured,
      reason: "At least 5 percentage points of observed usage are needed for a conversion.",
    };
  const usdPerPercentagePoint = costUsd / period.usedPercentagePoints;
  const calibrated = {
    ...measured,
    usdPerPercentagePoint,
    remainingValueUsd: usdPerPercentagePoint * period.last.remainingPercent,
  };
  if (period.resetKind === "unobserved")
    return {
      ...calibrated,
      reason:
        "Based on the last reading and current model mix. Usage after that reading is not included.",
    };
  if (period.resetKind === "ambiguous")
    return {
      ...calibrated,
      reason:
        "Value left is estimated at the last reading. This change cannot be identified as a reset.",
    };
  if (period.observationGapMs === null || period.observationGapMs > 60 * MINUTE_MS) {
    return {
      ...calibrated,
      reason:
        "Value left is estimated at the last reading. The reset observations are over an hour apart, so value left at the reset is unknown.",
    };
  }
  return {
    ...calibrated,
    unusedValueUsd: usdPerPercentagePoint * period.last.remainingPercent,
    reason:
      "Based on the last pre-reset observation and the same model mix. Usage between observations is unknown.",
  };
}

/** Lines stop across missing hours and reset changes; every point is a saved observation. */
export function quotaHistoryPoints(samples: readonly UsageQuotaSample[]) {
  const sorted = [...samples].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const firstTime = sorted[0] ? Date.parse(sorted[0].observedAt) : 0;
  const lastTime = sorted.at(-1) ? Date.parse(sorted.at(-1)!.observedAt) : firstTime;
  return sorted.map((sample, index) => {
    const previous = sorted[index - 1];
    const resetChange =
      previous !== undefined &&
      (sample.remainingPercent > previous.remainingPercent ||
        Math.abs(Date.parse(sample.resetsAt) - Date.parse(previous.resetsAt)) > MINUTE_MS);
    return {
      ...sample,
      x:
        lastTime === firstTime
          ? 0.5
          : (Date.parse(sample.observedAt) - firstTime) / (lastTime - firstTime),
      resetChange,
      breakBefore:
        previous === undefined ||
        resetChange ||
        Date.parse(sample.observedAt) - Date.parse(previous.observedAt) > 60 * MINUTE_MS,
    };
  });
}
