import type { UsageQuotaCostSnapshot, UsageQuotaInterval, UsageQuotaSample } from "@t3tools/contracts";

const sourceKey = (row: UsageQuotaCostSnapshot) => JSON.stringify([
  row.fingerprint.hostId, row.fingerprint.provider,
  row.fingerprint.resolvedHomePath, row.fingerprint.volumeId,
]);
const time = Date.parse;

/** Keep the longest observation per start, then sum distinct transcript homes. */
export function cleanResetLedger(rows: readonly UsageQuotaCostSnapshot[]) {
  const byStart = new Map<string, UsageQuotaCostSnapshot>();
  const observed = rows.filter((row) => row.fingerprint.provider === "codex" && !row.estimatedFromTranscripts && !/^(api-pace:|compare:|month:|codex-resets:)/.test(row.intervalId));
  for (const row of rows) {
    if (row.fingerprint.provider !== "codex" || /^(api-pace:|compare:|month:|codex-resets:)/.test(row.intervalId)) continue;
    if (row.estimatedFromTranscripts && observed.some((other) => time(other.sinceTime) < time(row.untilTime) && time(other.untilTime) > time(row.sinceTime))) continue;
    const key = `${sourceKey(row)}:${time(row.sinceTime)}`;
    const old = byStart.get(key);
    if (!old || time(row.untilTime) > time(old.untilTime) ||
      (time(row.untilTime) === time(old.untilTime) && time(row.recordedAt) > time(old.recordedAt))) byStart.set(key, row);
  }
  const longestEnd = new Map<number, number>();
  for (const row of byStart.values()) longestEnd.set(time(row.sinceTime), Math.max(longestEnd.get(time(row.sinceTime)) ?? 0, time(row.untilTime)));
  const candidates = [...byStart.values()].filter((row) => time(row.untilTime) === longestEnd.get(time(row.sinceTime)));
  const kept = candidates.filter((row) => !candidates.some((other) =>
    time(other.sinceTime) <= time(row.sinceTime) &&
    time(other.untilTime) >= time(row.untilTime) &&
    (time(other.sinceTime) < time(row.sinceTime) || time(other.untilTime) > time(row.untilTime)),
  ));
  const windows = new Map<number, UsageQuotaCostSnapshot[]>();
  for (const row of kept) {
    const start = time(row.sinceTime);
    windows.set(start, [...(windows.get(start) ?? []), row]);
  }
  return [...windows].sort(([a], [b]) => a - b).map(([, sources]) => ({
    sinceTime: sources[0]!.sinceTime,
    untilTime: sources.reduce((end, row) => time(row.untilTime) > time(end) ? row.untilTime : end, sources[0]!.untilTime),
    costUsd: Math.round(sources.reduce((sum, row) => sum + row.costUsd, 0) * 100) / 100,
    records: sources.reduce((sum, row) => sum + row.records, 0),
    lastRemainingPercent: sources[0]!.lastRemainingPercent,
    estimatedFromTranscripts: sources.every((row) => row.estimatedFromTranscripts),
    sources,
  }));
}

/** Fill only unpriced time. Public resets split gaps, never overwrite observed resets. */
export function resetHistoryPlan(
  rows: readonly UsageQuotaCostSnapshot[], sinceTime: string, now: string,
  publicResets: readonly string[],
  samples: readonly UsageQuotaSample[] = [],
) {
  const observed = cleanResetLedger(rows.filter((row) => !row.estimatedFromTranscripts));
  const start = time(sinceTime);
  const end = time(now);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return [];
  const boundaries = new Set([start, ...observed.map((row) => time(row.sinceTime)).filter((t) => t > start && t < end)]);
  const readings = samples.toSorted((a, b) => time(a.observedAt) - time(b.observedAt));
  for (const [index, sample] of readings.entries()) {
    const previous = readings[index - 1];
    const reset = time(sample.observedAt);
    if (reset <= start || reset >= end || previous && !(sample.remainingPercent > previous.remainingPercent && sample.resetsAt !== previous.resetsAt)) continue;
    if (!observed.some((row) => reset >= time(row.sinceTime) && reset <= time(row.untilTime))) boundaries.add(reset);
  }
  for (const reset of publicResets.map(time)) {
    if (reset <= start || reset >= end) continue;
    // A public announcement can precede the account reset. Observed windows own that boundary.
    if (observed.some((row, index) => reset >= time(row.sinceTime) && reset <= time(row.untilTime) + 15 * 60_000 ||
      Math.abs(reset - time(observed[index + 1]?.sinceTime ?? now)) < 15 * 60_000)) continue;
    boundaries.add(reset);
  }
  const starts = [...boundaries].sort((a, b) => a - b);
  return starts.map((from, index) => {
    const until = starts[index + 1] ?? end;
    const segments = cleanResetLedger(rows.filter((row) => time(row.sinceTime) >= from && time(row.untilTime) <= until));
    const lastReading = readings.findLast((sample) => time(sample.observedAt) >= from && time(sample.observedAt) < until);
    let cursor = from;
    const missing: UsageQuotaInterval[] = [];
    for (const segment of segments) {
      const gap = time(segment.sinceTime) - cursor;
      if (gap > 15 * 60_000) missing.push({ id: `transcript-window:${new Date(cursor).toISOString()}`, sinceTime: new Date(cursor).toISOString(), untilTime: segment.sinceTime });
      cursor = Math.max(cursor, time(segment.untilTime));
    }
    if (until - cursor > 15 * 60_000) missing.push({ id: `transcript-window:${new Date(cursor).toISOString()}`, sinceTime: new Date(cursor).toISOString(), untilTime: new Date(until).toISOString() });
    return {
      sinceTime: new Date(from).toISOString(), untilTime: new Date(until).toISOString(),
      open: index === starts.length - 1,
      costUsd: segments.reduce((sum, row) => sum + row.costUsd, 0),
      remainingPercent: lastReading?.remainingPercent ?? observed.find((row) => time(row.sinceTime) === from)?.lastRemainingPercent ?? null,
      estimatedFromTranscripts: lastReading === undefined && !observed.some((row) => time(row.sinceTime) === from),
      sources: segments.flatMap((segment) => segment.sources), missing,
    };
  });
}

export function subscriptionPayments(startDate: string, monthlyUsd: number, now: string) {
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = time(now);
  const payments: { month: string; paidUsd: number }[] = [];
  for (let offset = 0; offset < 1200; offset++) {
    const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1, 12));
    const lastDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    month.setUTCDate(Math.min(start.getUTCDate(), lastDay));
    if (month.getTime() > end) break;
    payments.push({ month: month.toISOString().slice(0, 7), paidUsd: monthlyUsd });
  }
  return payments;
}

export function usageMonthIntervals(startDate: string, now: string): UsageQuotaInterval[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const intervals: UsageQuotaInterval[] = [];
  for (let cursor = start; cursor.getTime() < time(now);) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const untilTime = next.getTime() < time(now) ? next.toISOString() : now;
    intervals.push({ id: `month:${cursor.toISOString().slice(0, 7)}`, sinceTime: cursor.toISOString(), untilTime });
    cursor = next;
  }
  return intervals;
}
