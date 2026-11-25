// @effect-diagnostics globalDate:off -- Calendar formatting takes explicit timestamps and a fixed time zone.
import type { OtisLaneUsage, UsageQuotaSample, UsageSummary } from "@t3tools/contracts";
import { quotaMonitoringSamples, quotaPeriods } from "./usageQuota.ts";
import { QUOTA_STALE_MS } from "./usageQuotaForecast.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RESET_JITTER = 10 * 60_000;
const SMOOTHING_WINDOW = 15 * 60_000;

// Plan mapping follows Otis integration/tools/usage-plan-value.mjs and the configured Claude Ultra plan.
export const PLANS = [
  {
    id: "claude",
    short: "Claude",
    plan: "Claude Ultra",
    providers: ["claude", "claudeAgent", "claude-code", "claude-app"],
    weekly: "claude:seven_day",
  },
  {
    id: "codex",
    short: "Codex",
    plan: "ChatGPT Pro",
    providers: ["codex", "chatgpt", "codex-cli"],
    weekly: "codex:weekly",
  },
  {
    id: "gemini",
    short: "Gemini",
    plan: "Google AI Pro",
    providers: ["antigravity", "gemini"],
    weekly: "antigravity:antigravity/gemini-weekly",
  },
] as const;

type Plan = (typeof PLANS)[number];
type PlanId = Plan["id"];
export function planForProvider(provider: string) {
  return PLANS.find((plan) => plan.providers.some((kind) => kind === provider));
}

export function planQuotaTime(time: number, now: number): string {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    ...(Math.abs(time - now) > 6 * DAY ? { month: "short", day: "numeric" } : {}),
  })
    .format(time)
    .replace(",", "");
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    ...(new Date(time).getUTCMinutes() !== 0 ? { minute: "2-digit" } : {}),
  }).format(time);
  return Math.abs(time - now) > 6 * DAY ? `${date}, ${clock}` : `${date} ${clock}`;
}

export function planRunOutTime(time: number, now: number): string {
  const halfHour = HOUR / 2;
  return planQuotaTime(Math.max(now, Math.floor(time / halfHour) * halfHour), now);
}

export function planUsageDays(now: number) {
  const timeZone = "America/Chicago";
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const untilDay = format.format(now);
  const sinceDay = new Date(Date.parse(untilDay) - DAY).toISOString().slice(0, 10);
  return { sinceDay, untilDay, timeZone } as const;
}

function observedAt(sample: UsageQuotaSample) {
  return Date.parse(sample.observedAt);
}

function smoothedRemaining(
  samples: readonly UsageQuotaSample[],
  time: number,
  provider: PlanId,
  centered = false,
) {
  const fallback = samples.findLast((sample) => observedAt(sample) <= time)?.remainingPercent;
  if (provider !== "gemini") return fallback;
  const values = samples
    .filter((sample) => {
      const delta = observedAt(sample) - time;
      return delta >= -SMOOTHING_WINDOW && delta <= (centered ? SMOOTHING_WINDOW : 0);
    })
    .map((sample) => sample.remainingPercent)
    .sort((a, b) => a - b);
  const center = Math.floor(values.length / 2);
  const right = values[center];
  return right === undefined
    ? fallback
    : (right + (values.length % 2 === 0 ? values[center - 1]! : right)) / 2;
}

function trailingPace(samples: readonly UsageQuotaSample[], provider: PlanId) {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return null;
  const now = observedAt(last);
  const start = Math.max(now - DAY, observedAt(first));
  const elapsed = now - start;
  if (
    elapsed < HOUR ||
    samples.some(
      (sample, index) =>
        index > 0 &&
        observedAt(sample) > start &&
        observedAt(sample) - observedAt(samples[index - 1]!) > DAY,
    )
  )
    return null;
  const initial = smoothedRemaining(samples, start, provider, true);
  const remaining = smoothedRemaining(samples, now, provider);
  if (initial === undefined || remaining === undefined || initial - remaining < 1) return null;
  return {
    perDay: ((initial - remaining) * DAY) / elapsed,
    sinceReset: elapsed === DAY ? null : start,
  };
}

export function planOutlook(
  samples: readonly UsageQuotaSample[] | undefined,
  now: number,
  provider: PlanId,
) {
  if (samples === undefined) return { status: "loading" } as const;
  const monitored = quotaMonitoringSamples(samples);
  const latest = monitored.at(-1);
  if (!latest) return { status: "missing" } as const;
  const observed = observedAt(latest);
  const reset = Date.parse(latest.resetsAt);
  const cycle = monitored.filter(
    (sample) => Math.abs(Date.parse(sample.resetsAt) - reset) <= RESET_JITTER,
  );
  // Exclude earlier cycles while allowing small balance jitter in Gemini's readings.
  let previous = 100;
  const basis = quotaPeriods(
    cycle.map((sample) => {
      previous =
        provider === "gemini"
          ? Math.min(previous, sample.remainingPercent)
          : sample.remainingPercent;
      return { ...sample, resetsAt: latest.resetsAt, remainingPercent: previous };
    }),
  ).at(-1)?.first.observedAt;
  const current = cycle.filter((sample) => basis === undefined || sample.observedAt >= basis);
  const remaining = smoothedRemaining(current, observed, provider) ?? latest.remainingPercent;
  const reading = { remaining, observed, reset };
  if (now - observed > QUOTA_STALE_MS || reset <= now)
    return { ...reading, status: "stale" } as const;
  if (remaining === 0) return { ...reading, status: "exhausted" } as const;
  const pace = trailingPace(current, provider);
  if (pace === null)
    return {
      ...reading,
      status: "noPace",
      firstObserved: observedAt(current[0] ?? latest),
    } as const;
  const hoursLeft = (24 * remaining) / pace.perDay;
  const resetHours = (reset - observed) / HOUR;
  const common = { ...reading, ...pace, hoursLeft, multiple: hoursLeft / resetHours };
  return hoursLeft < resetHours
    ? ({
        ...common,
        status: "runsOut",
        runsOutAt: observed + hoursLeft * HOUR,
        gap: (resetHours - hoursLeft) * HOUR,
        paceToLast: (24 * remaining) / resetHours,
      } as const)
    : ({
        ...common,
        status: "leftover",
        unused: Math.max(0, remaining - (pace.perDay * resetHours) / 24),
      } as const);
}

export type PlanOutlook = ReturnType<typeof planOutlook>;
export function planSamples(
  summary: UsageSummary | null,
  plan: Plan,
): readonly UsageQuotaSample[] | undefined {
  if (summary === null) return undefined;
  if (plan.id === "codex")
    return summary.quotaHistory?.status === "ready" ? summary.quotaHistory.samples : [];
  return (
    summary.providerQuotaHistories?.find(
      (window) =>
        window.status === "ready" && `${window.provider}:${window.windowId}` === plan.weekly,
    )?.samples ?? []
  );
}

export function moveWorkCallout(plans: readonly { plan: Plan; outlook: PlanOutlook }[]) {
  const short = plans
    .flatMap(({ plan, outlook }) => (outlook.status === "runsOut" ? [{ plan, outlook }] : []))
    .sort((a, b) => a.outlook.runsOutAt - b.outlook.runsOutAt)[0];
  if (!short) return null;
  const spare = plans
    .flatMap(({ plan, outlook }) =>
      outlook.status === "leftover" && outlook.unused >= 5 ? [{ plan, outlook }] : [],
    )
    .sort((a, b) => b.outlook.unused - a.outlook.unused)[0];
  if (!spare && plans.some(({ outlook }) => outlook.status === "leftover")) return null;
  return { short, spare };
}

export function parentShares(
  rows: OtisLaneUsage["rows"],
  plan: Plan,
  total: number,
  namedLanes: ReadonlyMap<string, string>,
) {
  if (total <= 0) return null;
  const costs = new Map<string, number>();
  const incomplete = new Set<string>();
  for (const row of rows) {
    if (planForProvider(row.provider)?.id !== plan.id) continue;
    if (!row.usage.complete || row.usage.costUsd === null) incomplete.add(row.lane);
    else costs.set(row.lane, (costs.get(row.lane) ?? 0) + row.usage.costUsd);
  }
  const parents = [...costs]
    .flatMap(([lane, cost]) => {
      const name = namedLanes.get(lane);
      return name && !incomplete.has(lane) ? [{ lane, name, share: cost / total }] : [];
    })
    .sort((a, b) => b.share - a.share);
  const displayedShare = parents.reduce((sum, parent) => sum + parent.share, 0);
  return parents.length && displayedShare <= 1
    ? { parents, other: 1 - displayedShare, partial: incomplete.size > 0 }
    : null;
}
