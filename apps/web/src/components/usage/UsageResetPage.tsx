import {
  watchResetAnnouncements,
  type ResetNews,
} from "@t3tools/client-runtime/resetAnnouncements";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { refreshCodexMonitor } from "@t3tools/client-runtime/usageRefresh";
import { formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import {
  quotaMonitoringSamples,
  quotaCostWindow,
  quotaIntervals,
  quotaPeriods,
  quotaValueSnapshots,
  quotaValueWithSnapshot,
  retainQuotaValueSnapshots,
  type QuotaValueSnapshot,
} from "@t3tools/shared/usageQuota";

import { isElectron } from "../../env";
import { useUsage } from "../../state/usage";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

import { UsagePaceChart } from "./UsagePaceChart";
import { ResetCheckPanel } from "./ResetCheckPanel";
import { CommunityCheckPanel } from "./CommunityCheckPanel";

const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
const estimate = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);

export function UsageResetPage() {
  const [historyInput] = useState(() => ({ ...makeWindow(1), quotaHistoryOnly: true }));
  const [news, setNews] = useState<ResetNews>({
    announcement: null,
    checkedAt: null,
    status: "loading",
  });
  const newsWatcher = useRef<ReturnType<typeof watchResetAnnouncements> | null>(null);
  useEffect(() => {
    const watcher = watchResetAnnouncements(setNews);
    newsWatcher.current = watcher;
    return () => {
      watcher.stop();
      newsWatcher.current = null;
    };
  }, []);
  const refreshActive = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const history = useUsage(historyInput);
  const refreshHistory = useEffectEvent(() => history.refresh());
  useEffect(() => {
    const timer = window.setInterval(refreshHistory, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshHistory();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const [trackerId, setTrackerId] = useState("");
  const [selectedIds, setSelectedIds] = useState<readonly string[] | null>(null);
  const trackers = history.environments.filter(
    (environment) =>
      environment.summary?.quotaHistory?.status === "ready" &&
      environment.summary.quotaHistory.samples.length > 0,
  );
  const tracker =
    trackers.find((environment) => environment.environmentId === trackerId) ?? trackers[0];
  const rawSamples = tracker?.summary?.quotaHistory?.samples;
  const samples = useMemo(() => quotaMonitoringSamples(rawSamples ?? []), [rawSamples]);
  const periods = useMemo(() => quotaPeriods(samples), [samples]);
  const intervals = useMemo(() => quotaIntervals(periods), [periods]);
  const costInput = useMemo(
    () => quotaCostWindow(intervals) ?? historyInput,
    [historyInput, intervals],
  );
  const costs = useUsage(costInput);
  const selected = useMemo(
    () =>
      costs.environments.filter(
        (environment) => selectedIds === null || selectedIds.includes(environment.environmentId),
      ),
    [costs.environments, selectedIds],
  );
  const currentValues = useMemo(
    () => quotaValueSnapshots(tracker?.environmentId, periods, selected),
    [tracker?.environmentId, periods, selected],
  );
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, QuotaValueSnapshot>>(
    () => new Map(),
  );
  useEffect(() => {
    setSnapshots((previous) => retainQuotaValueSnapshots(previous, currentValues));
  }, [currentValues]);
  const values = currentValues.map((current) => ({
    period: current.period,
    value: quotaValueWithSnapshot(current, snapshots),
  }));
  const last = samples.at(-1);
  const refreshMonitor = async () => {
    if (refreshActive.current) return;
    refreshActive.current = true;
    setRefreshing(true);
    setRefreshMessage("Refreshing readings, API costs and reset news…");
    try {
      setRefreshMessage(
        await refreshCodexMonitor({
          trackerId: tracker?.environmentId,
          refreshHistory: history.refresh,
          refreshCosts: costs.refresh,
          refreshNews: () => newsWatcher.current?.refresh() ?? Promise.resolve(false),
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

  const current = values.at(-1);
  const completed = values.slice(0, -1);
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
          <h1 className="truncate text-sm font-medium">Codex monitor</h1>
          <Button
            className="ms-auto size-11"
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh Codex usage"
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={() => void refreshMonitor()}
          >
            <RefreshCwIcon className={`size-4 ${refreshing ? "motion-safe:animate-spin" : ""}`} />
          </Button>
        </div>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <WorkspacePageContainer
          width="readable"
          className="pb-[calc(env(safe-area-inset-bottom)+3rem)]"
        >
          <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {refreshMessage || "Refresh checks saved readings, API costs and reset news."}
          </p>
          {history.isPending && !last ? <p role="status">Reading Codex usage…</p> : null}
          {history.environments.map((environment) => {
            const saved = environment.summary?.quotaHistory;
            const message =
              environment.error ??
              saved?.message ??
              (environment.summary && saved === undefined
                ? "Update this server to read quota history."
                : null);
            return message ? (
              <p
                key={environment.environmentId}
                role="status"
                className="text-sm text-muted-foreground"
              >
                {environment.label}: {message}
              </p>
            ) : null;
          })}
          {!history.isPending && !last ? (
            <p role="status" className="py-6 text-sm text-muted-foreground">
              No saved quota observations yet. The background collector must be running on a
              connected computer.
            </p>
          ) : null}
          {tracker && last && current ? (
            <>
              <UsagePaceChart
                samples={samples}
                news={news}
                resetCheck={
                  <>
                    <ResetCheckPanel
                      key={tracker.environmentId}
                      environmentId={tracker.environmentId}
                      label={tracker.label}
                    />
                    <CommunityCheckPanel
                      key={`community-${tracker.environmentId}`}
                      environmentId={tracker.environmentId}
                      label={tracker.label}
                    />
                  </>
                }
              />
              <section className="border-t border-border pt-5" aria-label="Tracked API value">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-sm font-medium">API-equivalent value</h2>
                  <span className="text-xs text-muted-foreground">This monitored cycle only</span>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-5 [&>div]:min-w-0">
                  <div>
                    <dt className="text-xs text-muted-foreground">Used while monitored</dt>
                    <dd className="mt-1 text-2xl tabular-nums">
                      {current.value.costUsd === null
                        ? "Pending"
                        : formatUsd(current.value.costUsd)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Value of usage remaining</dt>
                    <dd className="mt-1 text-2xl tabular-nums">
                      {current.value.remainingValueUsd === null
                        ? "Learning"
                        : `≈ ${estimate(current.value.remainingValueUsd)}`}
                    </dd>
                  </div>
                </dl>
                {current.period.usedPercentagePoints < 5 ? (
                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                    {current.period.usedPercentagePoints} of 5 percentage points observed. More
                    readings are needed to estimate dollars left. The {100 - last.remainingPercent}%
                    cycle total includes usage from before monitoring and cannot price this shorter
                    interval.
                  </p>
                ) : current.value.reason ? (
                  <p className="mt-3 text-xs text-muted-foreground">{current.value.reason}</p>
                ) : null}
                {current.value.costUsd === null ? (
                  <p className="mt-2 text-xs text-muted-foreground">{current.value.reason}</p>
                ) : null}
                {current.value.cachedAt ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Last complete calculation: {dateTime(current.value.cachedAt)}.
                  </p>
                ) : null}
                <p className="mt-3 text-xs text-muted-foreground">
                  Token-price estimate, not a bill or cash balance. Codex only.
                </p>
              </section>

              <section className="border-t border-border pt-5" aria-label="Resets while monitored">
                <h2 className="text-sm font-medium">Resets while monitored</h2>
                {completed.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    No reset observed since {dateTime(samples[0]!.observedAt)}. New resets will
                    appear here with the usage left beforehand.
                  </p>
                ) : (
                  <div className="mt-3 divide-y divide-border">
                    {completed.toReversed().map(({ period, value }) => (
                      <div key={period.id} className="flex flex-wrap justify-between gap-3 py-3">
                        <div>
                          <p className="text-sm">
                            {period.resetKind === "ambiguous"
                              ? "Usage window changed"
                              : "Usage returned"}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {dateTime(period.last.observedAt)} to{" "}
                            {dateTime(period.next!.observedAt)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm tabular-nums">
                            {period.last.remainingPercent}% left beforehand
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {value.unusedValueUsd === null
                              ? "Dollar estimate not established"
                              : `≈ ${estimate(value.unusedValueUsd)} unused`}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <details className="border-t border-border">
                <summary className="min-h-11 cursor-pointer content-center text-sm">
                  Tracking and computers
                </summary>
                <div className="space-y-4 pt-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Monitoring since {dateTime(samples[0]!.observedAt)}. {samples.length} readings.
                    Readings update every minute; the collector records every five minutes while the
                    computer is awake and signed in. Older history stays saved but is excluded after
                    a day-long monitoring gap.
                  </p>
                  <label className="flex flex-col gap-2 text-sm">
                    Quota source
                    <select
                      className="min-h-11 w-full rounded-md border border-border bg-background p-2 text-base"
                      value={tracker.environmentId}
                      onChange={(e) => setTrackerId(e.target.value)}
                    >
                      {trackers.map((environment) => (
                        <option key={environment.environmentId} value={environment.environmentId}>
                          {environment.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset>
                    <legend className="text-sm">Computers included in dollar estimates</legend>
                    {costs.environments.map((environment) => (
                      <label
                        key={environment.environmentId}
                        className="flex min-h-11 items-center gap-3 text-sm"
                      >
                        <input
                          type="checkbox"
                          className="size-5 shrink-0"
                          checked={
                            selectedIds === null || selectedIds.includes(environment.environmentId)
                          }
                          onChange={(event) => {
                            const ids =
                              selectedIds ?? costs.environments.map((entry) => entry.environmentId);
                            setSelectedIds(
                              event.target.checked
                                ? [...ids, environment.environmentId]
                                : ids.filter((id) => id !== environment.environmentId),
                            );
                          }}
                        />
                        <span className="break-words">{environment.label}</span>
                      </label>
                    ))}
                  </fieldset>
                  <p className="text-xs text-muted-foreground">
                    Choose computers using the same Codex account. Quota percentages are never added
                    across machines. Account identity and copied chats cannot be verified here.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Public reset news is checked every five minutes while this page is open. Only
                    the news service receives that request, without your usage, chat data or account
                    credentials.
                  </p>
                </div>
              </details>
            </>
          ) : null}
        </WorkspacePageContainer>
      </ScrollArea>
    </SidebarInset>
  );
}
