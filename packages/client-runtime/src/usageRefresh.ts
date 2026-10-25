import type { UsageQuotaSample, UsageSummary, UsageSummaryInput } from "@t3tools/contracts";
import { quotaCostWindow, quotaIntervals, quotaPeriods } from "@t3tools/shared/usageQuota";

interface UsageReply {
  readonly environmentId: string;
  readonly summary: UsageSummary | null;
  readonly error: string | null;
}

const codexWeeklySamples = (summary: UsageSummary | null) =>
  summary?.quotaHistory?.status === "ready" ? summary.quotaHistory.samples : undefined;

/**
 * Refresh costs for the newly read interval, not the interval on the old screen.
 * `windowSamples` picks the limit being monitored (Codex's weekly limit by default);
 * `quotaProvider` prices its intervals from that provider's transcripts.
 */
export async function refreshCodexMonitor(options: {
  readonly trackerId: string | undefined;
  readonly selectedCycleId?: string | null;
  readonly windowSamples?: (
    summary: UsageSummary | null,
  ) => readonly UsageQuotaSample[] | undefined;
  readonly quotaProvider?: UsageSummaryInput["quotaProvider"];
  readonly refreshHistory: () => Promise<readonly UsageReply[]>;
  readonly refreshCosts: (input: UsageSummaryInput) => Promise<readonly UsageReply[]>;
  readonly refreshNews: () => Promise<boolean>;
  readonly onProgress?: (message: string) => void;
}): Promise<string> {
  // The news watcher owns its status; public news must not hold usage refresh open.
  void options.refreshNews().catch(() => false);
  const windowSamples = options.windowSamples ?? codexWeeklySamples;
  const history = await options.refreshHistory();
  // A selected source that is ready but empty prices nothing; it never falls
  // back to another computer's readings, whose percentages are not additive.
  const trackers = history.filter((entry) => windowSamples(entry.summary) !== undefined);
  const tracker =
    trackers.find((entry) => entry.environmentId === options.trackerId) ?? trackers[0];
  const periods = quotaPeriods(windowSamples(tracker?.summary ?? null) ?? []);
  const selectedIndex = periods.findIndex((period) => period.id === options.selectedCycleId);
  const index = selectedIndex < 0 ? periods.length - 1 : selectedIndex;
  const window = quotaCostWindow(quotaIntervals(periods.slice(Math.max(0, index - 1), index + 1)));
  const input =
    window && options.quotaProvider !== undefined && options.quotaProvider !== "codex"
      ? { ...window, quotaProvider: options.quotaProvider }
      : window;
  if (input) options.onProgress?.("Saved readings refreshed. Updating API costs…");
  const costs = input ? await options.refreshCosts(input) : [];
  if (history.length === 0 || [...history, ...costs].some((entry) => entry.error)) {
    return "Some computers could not be refreshed. Check their connection below.";
  }
  if (costs.some((entry) => entry.summary?.sources.some((source) => source.status === "partial"))) {
    return "Readings refreshed. See API-cost details below for scan progress.";
  }
  return "Refreshed. Saved quota readings update about every five minutes.";
}

/** Stable property order lets imperative refreshes share the rendered query. */
export function usageQueryInput(
  input: UsageSummaryInput,
  clientContractVersion: number,
): UsageSummaryInput {
  return {
    clientContractVersion,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    resolution: input.resolution,
    sinceTime: input.sinceTime,
    untilTime: input.untilTime,
    includeRepeatedInput: input.includeRepeatedInput,
    includeQuotaHistory: input.includeQuotaHistory,
    quotaHistoryOnly: input.quotaHistoryOnly,
    quotaIntervals: input.quotaIntervals,
    // Absent for Codex, so existing Codex windows keep their query keys.
    quotaProvider: input.quotaProvider === "codex" ? undefined : input.quotaProvider,
  };
}
