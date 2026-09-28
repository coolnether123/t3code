import { BirthdayGreeting } from "../BirthdayCelebration";
import {
  watchResetAnnouncements,
  type ResetNews,
} from "@t3tools/client-runtime/resetAnnouncements";
import {
  publicResetCostEstimates,
  publicResetIntervals,
  watchPublicResetHistory,
  type PublicResetHistory,
} from "@t3tools/client-runtime/publicResetHistory";
import { refreshCodexMonitor } from "@t3tools/client-runtime/usageRefresh";
import type { UsageSummaryInput } from "@t3tools/contracts";
import { formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import {
  quotaMonitoringSamples,
  quotaCostWindow,
  quotaIntervals,
  quotaPeriods,
  quotaValueSnapshots,
  quotaValueWithHistoricalCalibration,
  quotaValueWithSnapshot,
  retainQuotaValueSnapshots,
  type QuotaValueSnapshot,
} from "@t3tools/shared/usageQuota";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "~/lib/utils";
import { useUsage } from "../../state/usage";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

import { chartActivityIntervals } from "./usageChartActivity";
import { apiPaceInterval, type PriorApiPaceInput } from "./usageApiPace";
import {
  hasReadings,
  LIMIT_PROVIDER_NAMES,
  limitWindows,
  windowSamplesFor,
  type LimitWindow,
} from "./usageLimitWindows";
import { readLimitsView, saveLimitsView, type LimitsView } from "./usagePagePreferences";
import { monitoredModels } from "./usageTokenBudget";
import { TokenBudgetPanel } from "./TokenBudgetPanel";
import { UsageCycleComparison } from "./UsageCycleComparison";
import { UsageLimitCards } from "./UsageLimitCards";
import { UsageModelTracker } from "./UsageModelTracker";
import { UsageMonitorSettings } from "./UsageMonitorSettings";
import { UsagePaceChart } from "./UsagePaceChart";
import { UsagePublicResets } from "./UsagePublicResets";
import { monitoredPeriodModels, UsageResetHistory } from "./UsageResetHistory";

const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const estimate = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);

type MonitorTab = LimitsView["tab"];
const TABS: readonly {
  readonly id: MonitorTab;
  readonly label: string;
  readonly codexOnly?: true;
}[] = [
  { id: "cycles", label: "Cycles" },
  { id: "models", label: "Models" },
  { id: "planner", label: "Planner", codexOnly: true },
  { id: "public", label: "Public resets", codexOnly: true },
];

function PendingHistoryStatus() {
  const [waitExceeded, setWaitExceeded] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setWaitExceeded(true), 15_000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {waitExceeded
        ? "Saved readings are taking longer than expected. Check this computer's connection or reload the page."
        : "Reading saved limits…"}
    </p>
  );
}

/** Shown in place of the chart when the selected limit has no saved readings. */
function LimitNotRecorded({ limit }: { readonly limit: LimitWindow }) {
  const name = `${LIMIT_PROVIDER_NAMES[limit.provider]} ${limit.label.toLowerCase()} limit`;
  return (
    <section className="rounded-lg border border-dashed border-border p-5" aria-label={name}>
      <h2 className="text-sm font-medium">No saved readings for the {name} yet</h2>
      {limit.message ? <p className="mt-2 text-sm text-muted-foreground">{limit.message}</p> : null}
      <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
        {limit.provider === "claude" ? (
          <>
            T3 reads Claude's session and weekly limits through the Claude CLI on this computer
            every few minutes, without sending a prompt. If the CLI is signed out, run{" "}
            <code className="rounded bg-muted px-1 py-0.5">claude auth login</code> once in a
            terminal; readings appear within a few minutes.
          </>
        ) : (
          <>Codex readings come from the Codex Limits tracker running on this computer.</>
        )}
      </p>
    </section>
  );
}

export function UsageResetPage() {
  const [historyInput] = useState(() => ({ ...makeWindow(1), quotaHistoryOnly: true }));
  const [view, setView] = useState(readLimitsView);
  const updateView = (next: Partial<LimitsView>) =>
    setView((previous) => {
      const merged = { ...previous, ...next };
      saveLimitsView(merged);
      return merged;
    });
  const [news, setNews] = useState<ResetNews>({
    announcement: null,
    checkedAt: null,
    status: "loading",
  });
  const newsWatcher = useRef<ReturnType<typeof watchResetAnnouncements> | null>(null);
  const [publicHistory, setPublicHistory] = useState<PublicResetHistory>({
    announcements: [],
    checkedAt: null,
    status: "loading",
  });
  const publicHistoryWatcher = useRef<ReturnType<typeof watchPublicResetHistory> | null>(null);
  useEffect(() => {
    const watcher = watchResetAnnouncements(setNews);
    newsWatcher.current = watcher;
    return () => {
      watcher.stop();
      newsWatcher.current = null;
    };
  }, []);
  useEffect(() => {
    const watcher = watchPublicResetHistory(setPublicHistory);
    publicHistoryWatcher.current = watcher;
    return () => {
      watcher.stop();
      publicHistoryWatcher.current = null;
    };
  }, []);
  const refreshActive = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const history = useUsage(historyInput);
  const [sourceId, setSourceId] = useState("");
  const [selectedIds, setSelectedIds] = useState<readonly string[] | null>(null);

  // The computer whose saved readings are charted, and every limit it reports.
  const sources = useMemo(
    () =>
      history.environments.filter((environment) =>
        limitWindows(environment.summary).some(hasReadings),
      ),
    [history.environments],
  );
  const source =
    sources.find((environment) => environment.environmentId === sourceId) ?? sources[0];
  const allWindows = useMemo(
    () =>
      limitWindows(
        source?.summary ??
          history.environments.find((environment) => environment.summary !== null)?.summary,
      ),
    [source, history.environments],
  );
  const visibleWindows = useMemo(
    () =>
      allWindows.filter((limit) => view.provider === "both" || limit.provider === view.provider),
    [allWindows, view.provider],
  );
  const selectedWindow = useMemo(
    () =>
      visibleWindows.find((limit) => limit.key === view.windowKey) ??
      visibleWindows.find(hasReadings) ??
      visibleWindows[0],
    [visibleWindows, view.windowKey],
  );
  const windowKey = selectedWindow?.key ?? "";
  const quotaProvider = selectedWindow?.provider ?? "codex";
  /** Cost reads for a Claude limit price Claude transcripts instead of Codex's. */
  const forProvider = useCallback(
    (input: UsageSummaryInput): UsageSummaryInput =>
      quotaProvider === "codex" ? input : { ...input, quotaProvider },
    [quotaProvider],
  );

  const sourceEnvironmentId = source?.environmentId;
  const effectiveSelectedIds = useMemo<readonly string[] | null>(
    () => selectedIds ?? (sourceEnvironmentId === undefined ? null : [sourceEnvironmentId]),
    [selectedIds, sourceEnvironmentId],
  );
  const rawSamples = useMemo(
    () => (selectedWindow && hasReadings(selectedWindow) ? selectedWindow.samples : undefined),
    [selectedWindow],
  );
  const samples = useMemo(() => quotaMonitoringSamples(rawSamples ?? []), [rawSamples]);
  // Graphs and cost panels share the complete saved cycles.
  const historicalPeriods = useMemo(() => quotaPeriods(rawSamples ?? []), [rawSamples]);
  // A chosen cycle belongs to the limit it was chosen on.
  const [cycleSelection, setCycleSelection] = useState<{
    readonly key: string;
    readonly cycle: string | null;
  } | null>(null);
  const selectedCycle = cycleSelection?.key === windowKey ? cycleSelection.cycle : null;
  const setSelectedCycle = (cycle: string | null) => setCycleSelection({ key: windowKey, cycle });
  const selectedPeriod =
    historicalPeriods.find((period) => period.id === selectedCycle) ?? historicalPeriods.at(-1);
  const periods = useMemo(
    () =>
      selectedPeriod
        ? historicalPeriods.slice(
            Math.max(0, historicalPeriods.indexOf(selectedPeriod) - 1),
            historicalPeriods.indexOf(selectedPeriod) + 1,
          )
        : [],
    [historicalPeriods, selectedPeriod],
  );
  const intervals = useMemo(() => quotaIntervals(periods), [periods]);
  const paceInterval = useMemo(() => apiPaceInterval(intervals.at(-1)), [intervals]);
  const costInput = useMemo(() => {
    const window = quotaCostWindow(intervals);
    return window ? forProvider(window) : historyInput;
  }, [historyInput, intervals, forProvider]);
  const costs = useUsage(costInput);

  // Background refresh: saved readings every minute while visible, then costs
  // for whatever interval the new readings imply. Uses the server's caches.
  const backgroundRefreshActive = useRef(false);
  const backgroundCostRefreshActive = useRef(false);
  const pendingBackgroundCostWindow = useRef<UsageSummaryInput | null>(null);
  const refreshBackgroundCosts = useEffectEvent(async () => {
    if (backgroundCostRefreshActive.current) return;
    backgroundCostRefreshActive.current = true;
    try {
      while (pendingBackgroundCostWindow.current) {
        const input = pendingBackgroundCostWindow.current;
        pendingBackgroundCostWindow.current = null;
        try {
          await costs.refresh(input);
        } catch {
          // The next visible reading retries a transiently unavailable environment.
        }
      }
    } finally {
      backgroundCostRefreshActive.current = false;
    }
  });
  const refreshVisibleMonitor = useEffectEvent(async () => {
    if (
      document.visibilityState !== "visible" ||
      refreshActive.current ||
      backgroundRefreshActive.current
    )
      return;
    backgroundRefreshActive.current = true;
    try {
      const refreshed = await history.refresh({ ...historyInput, refresh: false });
      const samplesOf = windowSamplesFor(windowKey);
      const latest =
        refreshed.find((entry) => entry.environmentId === source?.environmentId) ??
        refreshed.find((entry) => samplesOf(entry.summary) !== undefined);
      const latestPeriods = quotaPeriods(samplesOf(latest?.summary ?? null) ?? []);
      const selectedIndex = latestPeriods.findIndex((period) => period.id === selectedCycle);
      const index = selectedIndex < 0 ? latestPeriods.length - 1 : selectedIndex;
      const window = quotaCostWindow(
        quotaIntervals(latestPeriods.slice(Math.max(0, index - 1), index + 1)),
      );
      if (window) {
        pendingBackgroundCostWindow.current = { ...forProvider(window), refresh: false };
        void refreshBackgroundCosts();
      }
    } catch {
      // The next visible tick retries a transiently unavailable environment.
    } finally {
      backgroundRefreshActive.current = false;
    }
  });
  useEffect(() => {
    const timer = window.setInterval(() => void refreshVisibleMonitor(), 60_000);
    const onVisible = () => void refreshVisibleMonitor();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const [chartRange, setChartRange] = useState<{
    cycleId: string;
    range: readonly [number, number] | null;
  } | null>(null);
  const cycleSamples = useMemo(
    () =>
      selectedPeriod
        ? (rawSamples ?? []).filter(
            (sample) =>
              sample.observedAt >= selectedPeriod.first.observedAt &&
              sample.observedAt <= selectedPeriod.last.observedAt,
          )
        : [],
    [selectedPeriod, rawSamples],
  );
  const activityIntervals = useMemo(
    () =>
      selectedPeriod
        ? chartActivityIntervals(
            cycleSamples,
            chartRange?.cycleId === selectedPeriod.id ? chartRange.range : null,
          )
        : [],
    [selectedPeriod, cycleSamples, chartRange],
  );
  const modelActivityIntervals = useMemo(
    () => (selectedPeriod ? chartActivityIntervals(cycleSamples, null) : []),
    [selectedPeriod, cycleSamples],
  );
  // Let sibling reads start once the cycle read settles. A bounded transcript
  // scan may stay partial after its retries; that must not keep them waiting.
  const cycleCostsSettled = intervals.length === 0 || (!costs.isPending && !costs.isPartial);
  const paceInput = useMemo(
    () =>
      cycleCostsSettled && paceInterval
        ? forProvider(quotaCostWindow([paceInterval])!)
        : historyInput,
    [paceInterval, historyInput, cycleCostsSettled, forProvider],
  );
  const paceCosts = useUsage(paceInput);
  const [requestedActivityIntervals, setRequestedActivityIntervals] = useState(activityIntervals);
  useEffect(() => {
    const timer = window.setTimeout(() => setRequestedActivityIntervals(activityIntervals), 300);
    return () => window.clearTimeout(timer);
  }, [activityIntervals]);
  const activityInput = useMemo(() => {
    const window = cycleCostsSettled ? quotaCostWindow(requestedActivityIntervals) : null;
    return window ? forProvider(window) : historyInput;
  }, [requestedActivityIntervals, cycleCostsSettled, historyInput, forProvider]);
  const activityCosts = useUsage(activityInput);
  const modelActivityInput = useMemo(() => {
    const window = cycleCostsSettled ? quotaCostWindow(modelActivityIntervals) : null;
    return window ? forProvider(window) : historyInput;
  }, [modelActivityIntervals, cycleCostsSettled, historyInput, forProvider]);
  const modelActivityCosts = useUsage(modelActivityInput);
  const isSelected = useCallback(
    (environmentId: string) =>
      effectiveSelectedIds === null || effectiveSelectedIds.includes(environmentId),
    [effectiveSelectedIds],
  );
  const chartActivity = useMemo(() => {
    const environments = activityCosts.environments.filter((environment) =>
      isSelected(environment.environmentId),
    );
    return activityIntervals.map((interval) => ({
      interval,
      models: monitoredModels(interval, environments),
    }));
  }, [activityIntervals, activityCosts.environments, isSelected]);
  const modelChartActivity = useMemo(() => {
    const environments = modelActivityCosts.environments.filter((environment) =>
      isSelected(environment.environmentId),
    );
    return modelActivityIntervals.map((interval) => ({
      interval,
      models: monitoredModels(interval, environments),
    }));
  }, [modelActivityIntervals, modelActivityCosts.environments, isSelected]);
  const historical = periods.at(-2);
  const paceModels = useMemo(
    () =>
      paceInterval
        ? monitoredModels(
            paceInterval.id,
            paceCosts.environments.filter((environment) => isSelected(environment.environmentId)),
          )
        : null,
    [paceInterval, paceCosts.environments, isSelected],
  );
  // A new interval changes the cost query key. While that query is warming,
  // retain the history response for environments that have not answered yet;
  // its saved snapshots keep prior-cycle values visible without treating them
  // as current measured cost. A completed cost response always wins.
  const costEnvironments = useMemo(() => {
    const historyById = new Map(
      history.environments.map((environment) => [environment.environmentId, environment]),
    );
    const current = costs.environments.map((environment) => {
      if (environment.summary !== null || environment.error !== null) return environment;
      return historyById.get(environment.environmentId) ?? environment;
    });
    return current.length > 0 ? current : history.environments;
  }, [costs.environments, history.environments]);
  const selected = useMemo(
    () => costEnvironments.filter((environment) => isSelected(environment.environmentId)),
    [costEnvironments, isSelected],
  );
  const selectedWithSavedCosts = useMemo(
    () =>
      selected.map((environment) => {
        const historyEnvironment = history.environments.find(
          (candidate) => candidate.environmentId === environment.environmentId,
        );
        const snapshots = historyEnvironment?.summary?.quotaCostSnapshots;
        return snapshots === undefined
          ? environment
          : {
              ...environment,
              summary: environment.summary
                ? {
                    ...environment.summary,
                    quotaCostSnapshots: [
                      ...(environment.summary.quotaCostSnapshots ?? []),
                      ...snapshots,
                    ],
                  }
                : (historyEnvironment?.summary ?? environment.summary),
            };
      }),
    [history.environments, selected],
  );
  const costScope =
    selected.length === 0 ? "no computers" : selected.map((entry) => entry.label).join(", ");
  const currentValues = useMemo(
    () => quotaValueSnapshots(source?.environmentId, historicalPeriods, selectedWithSavedCosts),
    [source?.environmentId, historicalPeriods, selectedWithSavedCosts],
  );
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, QuotaValueSnapshot>>(
    () => new Map(),
  );
  useEffect(() => {
    setSnapshots((previous) => retainQuotaValueSnapshots(previous, currentValues));
  }, [currentValues]);
  const values = useMemo(
    () =>
      currentValues.map((current, index) => {
        const value = quotaValueWithSnapshot(current, snapshots);
        const previous = index > 0 ? currentValues[index - 1] : undefined;
        return {
          period: current.period,
          value: quotaValueWithHistoricalCalibration(
            { ...current, value },
            previous
              ? { ...previous, value: quotaValueWithSnapshot(previous, snapshots) }
              : undefined,
            currentValues.slice(0, index - 1).map((candidate) => ({
              ...candidate,
              value: quotaValueWithSnapshot(candidate, snapshots),
            })),
          ),
        };
      }),
    [currentValues, snapshots],
  );
  const valueByPeriod = useMemo(
    () => new Map(values.map(({ period, value }) => [period.id, value])),
    [values],
  );
  const last = samples.at(-1);
  const current = values.find(({ period }) => period.id === selectedPeriod?.id);
  const calibrationPeriod = useMemo(() => {
    const calibration = current?.value.historicalCalibration;
    if (!calibration) return historical;
    return historicalPeriods.find(
      (period) =>
        period.first.observedAt === calibration.since &&
        period.last.observedAt === calibration.until,
    );
  }, [current?.value.historicalCalibration, historical, historicalPeriods]);
  const calibrationInterval = useMemo(
    () => (calibrationPeriod ? (quotaIntervals([calibrationPeriod]).at(0) ?? null) : null),
    [calibrationPeriod],
  );
  const codexHistory = quotaProvider === "codex" ? source?.summary?.quotaHistory : undefined;
  const trackedManualResetCount = codexHistory?.bankedResetCount;
  const trackedManualResetCheckedAt = codexHistory?.bankedResetCheckedAt;
  // Nothing but Public resets can be shown before a limit has readings.
  const hasCycle = Boolean(source && selectedWindow && rawSamples && last && current);
  const tabs = TABS.filter(
    (tab) => (!tab.codexOnly || quotaProvider === "codex") && (hasCycle || tab.id === "public"),
  );
  const activeTab = tabs.some((tab) => tab.id === view.tab) ? view.tab : tabs[0]?.id;
  // Until some computer answers, a missing reading means "not read yet", not "not recorded".
  const historyAnswered = history.environments.some(
    (environment) => environment.summary !== null || environment.error !== null,
  );
  // Public-reset estimates are a Codex view, read only while their tab is open.
  const showPublic = activeTab === "public";
  const publicIntervals = useMemo(
    () => publicResetIntervals(publicHistory.announcements),
    [publicHistory.announcements],
  );
  const publicCostInput = useMemo(
    () =>
      showPublic && cycleCostsSettled
        ? (quotaCostWindow(publicIntervals) ?? historyInput)
        : historyInput,
    [historyInput, publicIntervals, cycleCostsSettled, showPublic],
  );
  const publicCosts = useUsage(publicCostInput);
  const selectedPublicCosts = useMemo(
    () => publicCosts.environments.filter((environment) => isSelected(environment.environmentId)),
    [isSelected, publicCosts.environments],
  );
  const publicEstimates = useMemo(
    () => publicResetCostEstimates(publicHistory.announcements, selectedPublicCosts),
    [publicHistory.announcements, selectedPublicCosts],
  );
  const publicCostsReady =
    publicCostInput !== historyInput && !publicCosts.isPending && !publicCosts.isPartial;
  const refreshMonitor = async () => {
    if (refreshActive.current) return;
    refreshActive.current = true;
    setRefreshing(true);
    setRefreshMessage("Refreshing readings and API costs…");
    try {
      setRefreshMessage(
        await refreshCodexMonitor({
          trackerId: source?.environmentId,
          selectedCycleId: selectedCycle,
          windowSamples: windowSamplesFor(windowKey),
          quotaProvider,
          refreshHistory: history.refresh,
          refreshCosts: async (input) => {
            const recentInterval = apiPaceInterval(input.quotaIntervals?.at(-1));
            const recentInput = recentInterval
              ? forProvider(quotaCostWindow([recentInterval])!)
              : null;
            const replies = await Promise.all([
              costs.refresh(input),
              recentInput ? paceCosts.refresh(recentInput) : Promise.resolve([]),
              showPublic ? publicCosts.refresh(publicCostInput) : Promise.resolve([]),
              activityCosts.refresh(activityInput),
              JSON.stringify(modelActivityInput) === JSON.stringify(activityInput)
                ? Promise.resolve([])
                : modelActivityCosts.refresh(modelActivityInput),
            ]);
            return replies.flat();
          },
          refreshNews: async () => {
            const results = await Promise.all([
              newsWatcher.current?.refresh() ?? Promise.resolve(false),
              publicHistoryWatcher.current?.refresh() ?? Promise.resolve(false),
            ]);
            return results.some(Boolean);
          },
          onProgress: setRefreshMessage,
        }),
      );
    } catch {
      setRefreshMessage("Refresh did not finish. Check your connection and try again.");
    } finally {
      refreshActive.current = false;
      setRefreshing(false);
    }
  };

  const priorApiPace = useMemo<PriorApiPaceInput | null>(() => {
    if (!calibrationPeriod || !calibrationInterval || !current) return null;
    return {
      interval: calibrationInterval,
      period: calibrationPeriod,
      models: monitoredModels(calibrationInterval, selectedWithSavedCosts),
      remainingValueUsd: current.value.remainingValueUsd,
      ...(current.value.historicalCalibration && calibrationPeriod.id !== historical?.id
        ? { calibrationTargetSince: current.period.first.observedAt }
        : {}),
    };
  }, [calibrationPeriod, calibrationInterval, selectedWithSavedCosts, current, historical]);
  const currentModels = useMemo(
    () =>
      current ? monitoredPeriodModels(current.period, current.value, selectedWithSavedCosts) : null,
    [current, selectedWithSavedCosts],
  );
  const models =
    currentModels ??
    (current?.value.historicalCalibration !== undefined ? (priorApiPace?.models ?? null) : null);

  const sourceMessage = (() => {
    const environment = source ?? history.environments[0];
    if (!environment) return null;
    if (environment.error) return `${environment.label}: ${environment.error}`;
    if (
      environment.summary === null &&
      environment.isPending &&
      environment.connection.phase === "reconnecting"
    ) {
      return `${environment.label} is reconnecting. Limits appear when it is back.`;
    }
    return null;
  })();
  const chartRef = useRef<HTMLDivElement>(null);
  const valueNote = current
    ? current.value.costObservedUntil
      ? `API value is complete through ${dateTime(current.value.costObservedUntil)}; newer transcript usage is still being read.`
      : current.value.historicalCalibration
        ? `Remaining value is provisional, calibrated from ${dateTime(current.value.historicalCalibration.since)} to ${dateTime(current.value.historicalCalibration.until)} until this cycle has enough measured use.`
        : current.period.usedPercentagePoints < 5 && current.value.remainingValueUsd === null
          ? `${current.period.usedPercentagePoints} of 5 percentage points observed; more readings are needed to price what is left.`
          : current.value.reason
    : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron}>
        <div className="flex w-full min-w-0 items-center gap-3">
          <Link
            to="/usage"
            className="inline-flex min-h-11 items-center rounded-md text-sm text-muted-foreground hover:text-foreground"
          >
            Usage
          </Link>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <h1 className="truncate text-sm font-medium">Limits</h1>
          <ToggleGroup
            aria-label="Providers"
            className="ms-2"
            variant="segmented"
            value={[view.provider]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "codex" || next === "claude" || next === "both") {
                updateView({ provider: next });
              }
            }}
          >
            <Toggle value="codex">Codex</Toggle>
            <Toggle value="claude">Claude</Toggle>
            <Toggle value="both">Both</Toggle>
          </ToggleGroup>
          <div className="ms-auto flex items-center gap-1">
            <UsageMonitorSettings
              sources={sources.map((environment) => ({
                id: environment.environmentId,
                label: environment.label,
              }))}
              sourceId={source?.environmentId}
              onSourceChange={setSourceId}
              computers={costs.environments.map((environment) => ({
                id: environment.environmentId,
                label: environment.label,
              }))}
              includedIds={effectiveSelectedIds}
              onIncludedChange={setSelectedIds}
              monitoringSince={samples[0]?.observedAt ?? null}
              readingCount={samples.length}
            />
            <Button
              className="size-9"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh limits"
              title="Refresh limits"
              aria-busy={refreshing}
              disabled={refreshing}
              onClick={() => void refreshMonitor()}
            >
              <RefreshCwIcon className={`size-4 ${refreshing ? "motion-safe:animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <WorkspacePageContainer
          width="expanded"
          className="max-w-none gap-4 px-3 pt-3 sm:px-5 pb-[calc(env(safe-area-inset-bottom)+3rem)]"
        >
          {refreshMessage || sourceMessage ? (
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {[refreshMessage, sourceMessage].filter(Boolean).join(" ")}
            </p>
          ) : null}
          {!historyAnswered && history.environments.length > 0 && sourceMessage === null ? (
            <PendingHistoryStatus />
          ) : null}
          {!history.isPending && history.environments.length === 0 ? (
            <p role="status" className="py-6 text-sm text-muted-foreground">
              No saved limit readings yet. They appear once a connected computer records them.
            </p>
          ) : null}
          {historyAnswered && visibleWindows.length > 0 ? (
            <UsageLimitCards
              windows={visibleWindows}
              selectedKey={windowKey}
              onSelect={(key) => updateView({ windowKey: key })}
              onShowOnly={(provider) => updateView({ provider })}
            />
          ) : null}
          {historyAnswered && selectedWindow && !hasReadings(selectedWindow) ? (
            <LimitNotRecorded limit={selectedWindow} />
          ) : null}
          {source && selectedWindow && rawSamples && last && current ? (
            <div ref={chartRef} className="scroll-mt-3">
              <UsagePaceChart
                key={`${source.environmentId}:${windowKey}`}
                samples={rawSamples}
                activity={chartActivity}
                onRangeChange={(range) => {
                  if (selectedPeriod) setChartRange({ cycleId: selectedPeriod.id, range });
                }}
                selectedCycle={selectedCycle}
                onCycleChange={setSelectedCycle}
                windowMs={selectedWindow.windowMs}
                title={`${selectedWindow.label} limit`}
                providerName={LIMIT_PROVIDER_NAMES[quotaProvider]}
                {...(quotaProvider === "codex" ? { news } : {})}
                manualResets={
                  trackedManualResetCount === undefined
                    ? null
                    : {
                        availableCount: trackedManualResetCount,
                        verified: trackedManualResetCheckedAt !== undefined,
                        ...(trackedManualResetCheckedAt === undefined
                          ? {}
                          : { checkedAt: trackedManualResetCheckedAt }),
                      }
                }
                apiPace={
                  paceInterval
                    ? {
                        interval: paceInterval,
                        models: paceModels,
                        remainingValueUsd: current.value.cachedAt
                          ? null
                          : current.value.remainingValueUsd,
                      }
                    : null
                }
                priorApiPace={priorApiPace}
                stats={
                  <>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <div id="api-value" className="flex justify-between gap-2" tabIndex={0} />
                        }
                      >
                        <dt className="text-muted-foreground">API value</dt>
                        <dd className="tabular-nums">
                          {current.value.costUsd === null
                            ? "Pending"
                            : formatUsd(current.value.costUsd)}
                        </dd>
                      </TooltipTrigger>
                      <TooltipPopup>
                        API-equivalent value of the recorded transcript usage this cycle. An
                        estimate, not a bill.
                      </TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <div
                            id="api-left"
                            className="hidden justify-between gap-2 lg:flex"
                            tabIndex={0}
                          />
                        }
                      >
                        <dt className="text-muted-foreground">Left at API prices</dt>
                        <dd className="tabular-nums">
                          {current.value.remainingValueUsd === null
                            ? "Learning"
                            : `≈ ${estimate(current.value.remainingValueUsd)}`}
                        </dd>
                      </TooltipTrigger>
                      <TooltipPopup>
                        What the remaining limit is worth at API prices, at this cycle's burn.
                      </TooltipPopup>
                    </Tooltip>
                  </>
                }
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Transcript costs from {costScope}
                {valueNote ? ` · ${valueNote}` : ""}
              </p>
            </div>
          ) : null}
          {historyAnswered && activeTab !== undefined ? (
            <section aria-label="Limit details" className="min-w-0">
              <div
                role="tablist"
                aria-label="Limit details"
                className="flex gap-5 overflow-x-auto border-b border-border"
              >
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    id={`limits-tab-${tab.id}`}
                    aria-selected={activeTab === tab.id}
                    aria-controls={`limits-panel-${tab.id}`}
                    onClick={() => updateView({ tab: tab.id })}
                    className={cn(
                      "-mb-px shrink-0 border-b-2 px-0.5 pb-2 text-sm focus-visible:outline-2 focus-visible:outline-ring",
                      activeTab === tab.id
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div
                role="tabpanel"
                id={`limits-panel-${activeTab}`}
                aria-labelledby={`limits-tab-${activeTab}`}
                className="space-y-5 pt-4"
              >
                {activeTab === "public" ? (
                  <UsagePublicResets
                    history={publicHistory}
                    estimates={publicEstimates}
                    costsReady={publicCostsReady}
                    scope={costScope}
                  />
                ) : !source || !rawSamples || !current ? null : activeTab === "cycles" ? (
                  <>
                    <UsageResetHistory
                      periods={historicalPeriods}
                      values={valueByPeriod}
                      environments={selectedWithSavedCosts}
                      selectedCycle={selectedCycle}
                      monitoringSince={samples[0]!.observedAt}
                      onSelectCycle={(cycleId) => {
                        setSelectedCycle(cycleId);
                        chartRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
                      }}
                    />
                    <UsageCycleComparison
                      key={`${source.environmentId}:${windowKey}`}
                      period={current.period}
                      periods={historicalPeriods}
                      samples={rawSamples}
                      selectedIds={effectiveSelectedIds}
                    />
                  </>
                ) : activeTab === "models" ? (
                  <>
                    <UsageModelTracker
                      key={`${source.environmentId}:${windowKey}:${current.period.id}`}
                      period={current.period}
                      samples={rawSamples}
                      models={currentModels}
                      activity={modelChartActivity}
                      scope={costScope}
                    />
                  </>
                ) : (
                  <TokenBudgetPanel
                    budgetUsd={current.value.remainingValueUsd}
                    models={models}
                    observedAt={current.period.last.observedAt}
                    provisional={current.value.historicalCalibration !== undefined}
                    {...(current.value.costObservedUntil && !current.value.historicalCalibration
                      ? { currentPrefixThrough: current.value.costObservedUntil }
                      : {})}
                    priorModelMix={
                      currentModels === null && current.value.historicalCalibration !== undefined
                    }
                    {...(current.value.historicalCalibration
                      ? { calibration: current.value.historicalCalibration }
                      : {})}
                  />
                )}
              </div>
            </section>
          ) : null}
          <BirthdayGreeting />
        </WorkspacePageContainer>
      </ScrollArea>
    </SidebarInset>
  );
}
