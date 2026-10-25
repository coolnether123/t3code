import type { UsageQuotaSample, UsageSummary } from "@t3tools/contracts";
import { QUOTA_STALE_MS, QUOTA_WEEK_MS, quotaForecast } from "@t3tools/shared/usageQuotaForecast";

export type LimitProvider = "codex" | "claude";
export type LimitProviderFilter = LimitProvider | "both";

export const LIMIT_PROVIDER_NAMES: Readonly<Record<LimitProvider, string>> = {
  codex: "Codex",
  claude: "Claude",
};

/** One subscription limit the monitor can chart: Codex's weekly limit or a Claude window. */
export interface LimitWindow {
  readonly key: string;
  readonly provider: LimitProvider;
  readonly windowId: string;
  /** Short name within its provider, such as "Weekly" or "Session". */
  readonly label: string;
  readonly windowMs: number;
  readonly status: "ready" | "missing" | "unavailable" | "invalid";
  readonly message: string | null;
  readonly samples: readonly UsageQuotaSample[];
}

export const CODEX_WEEKLY_KEY = "codex:weekly";

/** Every limit window one environment reports, Codex first. */
export function limitWindows(summary: UsageSummary | null | undefined): readonly LimitWindow[] {
  const codex = summary?.quotaHistory;
  const windows: LimitWindow[] = [
    {
      key: CODEX_WEEKLY_KEY,
      provider: "codex",
      windowId: "weekly",
      label: "Weekly",
      windowMs: QUOTA_WEEK_MS,
      status:
        codex === undefined || (codex.status === "ready" && codex.samples.length === 0)
          ? "missing"
          : codex.status,
      message:
        codex?.message ??
        (codex === undefined && summary !== null && summary !== undefined
          ? "This computer's server does not report quota history."
          : null),
      samples: codex?.status === "ready" ? codex.samples : [],
    },
  ];
  for (const history of summary?.providerQuotaHistories ?? []) {
    windows.push({
      key: `${history.provider}:${history.windowId}`,
      provider: history.provider,
      windowId: history.windowId,
      label: history.label,
      windowMs: (history.windowDurationMins ?? 7 * 24 * 60) * 60_000,
      status:
        history.status === "ready" && history.samples.length === 0 ? "missing" : history.status,
      message: history.message,
      samples: history.status === "ready" ? history.samples : [],
    });
  }
  if (summary !== null && summary !== undefined && summary.providerQuotaHistories === undefined) {
    windows.push({
      key: "claude:seven_day",
      provider: "claude",
      windowId: "seven_day",
      label: "Weekly",
      windowMs: QUOTA_WEEK_MS,
      status: "missing",
      message: "Update this computer's T3 server to record Claude limits.",
      samples: [],
    });
  }
  return windows;
}

export const hasReadings = (window: LimitWindow) =>
  window.status === "ready" && window.samples.length > 0;

/** Picks one window's saved readings out of a refreshed summary. */
export const windowSamplesFor =
  (key: string) =>
  (summary: UsageSummary | null): readonly UsageQuotaSample[] | undefined => {
    const window = limitWindows(summary).find((candidate) => candidate.key === key);
    return window && hasReadings(window) ? window.samples : undefined;
  };

export interface LimitWindowSummary {
  readonly remainingPercent: number;
  readonly resetsAt: string;
  readonly resetInMs: number;
  /** Percentage points used beyond an even pace through the window; positive is behind pace. */
  readonly paceDelta: number;
  readonly stale: boolean;
  readonly observedAt: string;
}

/** The headline numbers for a limit card, from its latest saved reading. */
export function limitWindowSummary(window: LimitWindow, now: number): LimitWindowSummary | null {
  if (!hasReadings(window)) return null;
  const latest = window.samples.at(-1)!;
  const forecast = quotaForecast(window.samples, now, 3, undefined, window.windowMs);
  const resetsAtMs = Date.parse(latest.resetsAt);
  return {
    remainingPercent: latest.remainingPercent,
    resetsAt: latest.resetsAt,
    resetInMs: Math.max(0, resetsAtMs - now),
    paceDelta: forecast?.paceDelta ?? 0,
    stale: now - Date.parse(latest.observedAt) > QUOTA_STALE_MS || resetsAtMs < now,
    observedAt: latest.observedAt,
  };
}
