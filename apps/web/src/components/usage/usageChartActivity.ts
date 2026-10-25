import type { UsageQuotaInterval, UsageQuotaSample } from "@t3tools/contracts";
import { quotaHistoryPoints } from "@t3tools/shared/usageQuota";
import { monitoredModels } from "./usageTokenBudget";

export interface ChartActivity {
  readonly interval: UsageQuotaInterval;
  readonly models: ReturnType<typeof monitoredModels>;
}

/** Bound the query to 48 bins, including the observations bracketing a zoom. */
export function chartActivityIntervals(
  inputSamples: readonly UsageQuotaSample[],
  range: readonly [number, number] | null,
): UsageQuotaInterval[] {
  const samples = [...inputSamples].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return [];
  const milestones = samples.filter(
    (sample, index) =>
      index === 0 ||
      sample.remainingPercent !== samples[index - 1]!.remainingPercent ||
      Math.abs(Date.parse(sample.resetsAt) - Date.parse(samples[index - 1]!.resetsAt)) > 60_000,
  );
  const preceding = range
    ? milestones.findLastIndex((sample) => Date.parse(sample.observedAt) <= range[0])
    : 0;
  const start = range
    ? Date.parse(milestones[Math.max(0, preceding - 1)]?.observedAt ?? first.observedAt)
    : Date.parse(first.observedAt);
  const end = range
    ? Date.parse(
        milestones.find((sample) => Date.parse(sample.observedAt) >= range[1])?.observedAt ??
          last.observedAt,
      )
    : Date.parse(last.observedAt);
  if (end <= start) return [];
  const count = Math.min(48, Math.max(1, Math.ceil((end - start) / 60_000)));
  return Array.from({ length: count }, (_, index) => {
    const sinceTime = new Date(start + Math.round(((end - start) * index) / count)).toISOString();
    const untilTime = new Date(
      start + Math.round(((end - start) * (index + 1)) / count),
    ).toISOString();
    return { id: `chart:${sinceTime}:${untilTime}`, sinceTime, untilTime };
  });
}

/** Whole-percent changes are thresholds; repeated readings do not pin fractional usage. */
export function quotaActivityPoints(
  samples: readonly UsageQuotaSample[],
  activity: readonly ChartActivity[],
) {
  const points = quotaHistoryPoints(samples);
  type Point = (typeof points)[number] & { estimated: boolean; provisional: boolean };
  if (points.length === 0) return [] as Point[];
  const bins = activity.map((row) => ({
    start: Date.parse(row.interval.sinceTime),
    end: Date.parse(row.interval.untilTime),
    cost: row.models === null ? null : row.models.reduce((sum, model) => sum + model.costUsd, 0),
  }));
  const costBetween = (start: number, end: number) => {
    let covered = start;
    let cost = 0;
    for (const bin of bins) {
      if (bin.end <= start || bin.start >= end) continue;
      if (bin.cost === null || bin.start > covered) return null;
      cost +=
        (bin.cost * (Math.min(end, bin.end) - Math.max(start, bin.start))) / (bin.end - bin.start);
      covered = Math.min(end, bin.end);
    }
    return covered < end ? null : cost;
  };
  const result: Point[] = [{ ...points[0]!, estimated: false, provisional: false }];
  let anchor = 0;
  let usdPerPoint: number | null = null;
  while (anchor < points.length - 1) {
    const first = points[anchor]!;
    let next = anchor + 1;
    while (
      next < points.length &&
      !points[next]!.breakBefore &&
      points[next]!.remainingPercent === first.remainingPercent
    )
      next++;
    const provisional = next === points.length;
    if (provisional) next = points.length - 1;
    const last = points[next]!;
    const start = Date.parse(first.observedAt);
    const end = Date.parse(last.observedAt);
    const cost = costBetween(start, end);
    const observedDrop = first.remainingPercent - last.remainingPercent;
    const canEstimate =
      !last.breakBefore &&
      cost !== null &&
      cost > 0 &&
      (observedDrop > 0 || (provisional && usdPerPoint !== null));
    if (canEstimate) {
      // Until the next whole-percent change arrives, remain inside the last reported band.
      const drop = provisional ? Math.min(0.99, cost / usdPerPoint!) : observedDrop;
      const times = new Set(
        points.slice(anchor + 1, next + 1).map((point) => Date.parse(point.observedAt)),
      );
      for (const bin of bins) if (bin.end > start && bin.end < end) times.add(bin.end);
      for (const at of [...times].sort((a, b) => a - b)) {
        const cumulative = costBetween(start, at)!;
        // The unfinished tail follows its calibrated rate until it reaches the band's lower edge.
        const used = provisional
          ? Math.min(0.99, cumulative / usdPerPoint!)
          : (drop * cumulative) / cost;
        result.push({
          ...last,
          observedAt: new Date(at).toISOString(),
          remainingPercent: Math.max(0, first.remainingPercent - used),
          breakBefore: false,
          estimated: provisional || at !== end,
          provisional,
        });
      }
      if (!provisional) usdPerPoint = cost / observedDrop;
    } else {
      result.push(
        ...points
          .slice(anchor + 1, next + 1)
          .map((point) => ({ ...point, estimated: false, provisional: false })),
      );
      if (!provisional) usdPerPoint = null;
    }
    anchor = next;
  }
  return result;
}

/** Locate each integer boundary on the estimated curve, excluding reset jumps. */
export function quotaPercentCrossings(points: ReturnType<typeof quotaActivityPoints>) {
  return points.flatMap((point, index) => {
    const previous = points[index - 1];
    if (!previous || point.breakBefore || previous.remainingPercent <= point.remainingPercent)
      return [];
    const crossings: { at: number; percent: number }[] = [];
    for (
      let percent = Math.ceil(previous.remainingPercent) - 1;
      percent >= Math.ceil(point.remainingPercent);
      percent--
    ) {
      const fraction =
        (previous.remainingPercent - percent) /
        (previous.remainingPercent - point.remainingPercent);
      crossings.push({
        percent,
        at:
          Date.parse(previous.observedAt) +
          fraction * (Date.parse(point.observedAt) - Date.parse(previous.observedAt)),
      });
    }
    return crossings;
  });
}

/** Partial bins are prorated; the UI labels their visible totals as estimates. */
export function visibleChartActivity(
  activity: readonly ChartActivity[],
  start: number,
  end: number,
) {
  const models = new Map<string, number>();
  const bins: {
    id: string;
    start: number;
    end: number;
    cost: number | null;
    perHour: number | null;
    models: readonly (readonly [string, number])[];
  }[] = [];
  let cost = 0;
  let peak: { start: number; end: number; cost: number; perHour: number } | null = null;
  let complete = activity.length > 0;
  for (const row of activity) {
    const since = Date.parse(row.interval.sinceTime);
    const until = Date.parse(row.interval.untilTime);
    const overlap = Math.max(0, Math.min(end, until) - Math.max(start, since));
    if (overlap === 0) continue;
    if (row.models === null) {
      complete = false;
      bins.push({
        id: row.interval.id,
        start: Math.max(start, since),
        end: Math.min(end, until),
        cost: null,
        perHour: null,
        models: [],
      });
      continue;
    }
    let binCost = 0;
    const binModels: [string, number][] = [];
    for (const model of row.models) {
      const value = (model.costUsd * overlap) / (until - since);
      models.set(model.model, (models.get(model.model) ?? 0) + value);
      cost += value;
      binCost += value;
      binModels.push([model.model, value]);
    }
    const perHour = (binCost * 3_600_000) / overlap;
    bins.push({
      id: row.interval.id,
      start: Math.max(start, since),
      end: Math.min(end, until),
      cost: binCost,
      perHour,
      models: binModels.sort((a, b) => b[1] - a[1]),
    });
    if (!peak || perHour > peak.perHour)
      peak = { start: Math.max(start, since), end: Math.min(end, until), cost: binCost, perHour };
  }
  const duration = bins.reduce((sum, bin) => sum + bin.end - bin.start, 0);
  const ranked = [...bins].sort((a, b) => (b.perHour ?? -1) - (a.perHour ?? -1));
  let busiestTime = duration / 4;
  let busiestCost = 0;
  for (const bin of ranked) {
    const take = Math.min(busiestTime, bin.end - bin.start);
    busiestCost += ((bin.cost ?? 0) * take) / (bin.end - bin.start);
    busiestTime -= take;
  }
  return {
    cost,
    complete,
    peak,
    bins,
    ranked,
    averagePerHour: duration > 0 && complete ? (cost * 3_600_000) / duration : null,
    busiestQuarterShare: complete && cost > 0 ? busiestCost / cost : null,
    models: [...models].sort((a, b) => b[1] - a[1]),
  };
}

/** Interpolate only between points in the same cycle; never invent coverage at the edges. */
export function estimatedQuotaDrop(
  points: ReturnType<typeof quotaActivityPoints>,
  start: number,
  end: number,
): number | null {
  const balanceAt = (at: number) => {
    const right = points.findIndex((point) => Date.parse(point.observedAt) >= at);
    if (right < 0) return null;
    const next = points[right]!;
    if (Date.parse(next.observedAt) === at) return next.remainingPercent;
    const previous = points[right - 1];
    if (!previous || next.breakBefore) return null;
    const from = Date.parse(previous.observedAt);
    return (
      previous.remainingPercent +
      ((next.remainingPercent - previous.remainingPercent) * (at - from)) /
        (Date.parse(next.observedAt) - from)
    );
  };
  if (
    points.some(
      (point) =>
        point.breakBefore &&
        Date.parse(point.observedAt) > start &&
        Date.parse(point.observedAt) <= end,
    )
  )
    return null;
  const first = balanceAt(start);
  const last = balanceAt(end);
  return first === null || last === null ? null : Math.max(0, first - last);
}
