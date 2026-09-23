import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { formatDayShort, makeWindow } from "@t3tools/shared/usageFormat";
import { mergeRepeatedInputSummaries } from "@t3tools/shared/usageRepeatedInput";

import { isElectron } from "../../env";
import { useUsage } from "../../state/usage";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { RepeatedInputSection } from "./RepeatedInputSection";

const PERIODS = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
  [120, "120 days"],
  [365, "1 year"],
] as const;
const SELECT_CLASS =
  "min-h-11 min-w-0 rounded-md border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export function RepeatedInputPage() {
  const [selection, setSelection] = useState(() => ({ days: 30, window: makeWindow(30) }));
  const [environmentId, setEnvironmentId] = useState("all");
  const { environments, refresh } = useUsage({
    ...selection.window,
    includeRepeatedInput: true,
  });
  const selected = useMemo(
    () =>
      environments.filter(
        (entry) => environmentId === "all" || entry.environmentId === environmentId,
      ),
    [environments, environmentId],
  );
  const data = useMemo(() => mergeRepeatedInputSummaries(selected), [selected]);
  const pending = selected.some((entry) => entry.isPending);
  const incomplete = selected.filter(
    (entry) =>
      entry.error !== null ||
      entry.isPending ||
      entry.summary?.repeatedInput?.catalog === undefined,
  );
  const failed = selected.some((entry) => entry.error !== null);
  const refreshWindow = () => {
    const window = makeWindow(selection.days);
    if (
      window.sinceDay === selection.window.sinceDay &&
      window.untilDay === selection.window.untilDay
    ) {
      void refresh();
    } else {
      setSelection({ days: selection.days, window });
    }
  };

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron}>
        <div className="flex w-full min-w-0 items-center justify-between gap-3">
          <Link
            to="/usage"
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ArrowLeftIcon aria-hidden className="size-4" />
            Usage
          </Link>
          <span className="truncate text-sm font-medium">Skills &amp; repeated input</span>
        </div>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <WorkspacePageContainer width="wide" className="gap-8">
          <div className="space-y-5">
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                Skills &amp; repeated input
              </h1>
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                See which skills and reusable instructions enter your conversations, how often they
                appear, and the input tokens attributed to them.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs text-muted-foreground sm:flex-none">
                Period
                <select
                  aria-label="Repeated input period"
                  className={SELECT_CLASS}
                  value={selection.days}
                  onChange={(event) => {
                    const days = Number(event.target.value);
                    setSelection({ days, window: makeWindow(days) });
                  }}
                >
                  {PERIODS.map(([days, label]) => (
                    <option key={days} value={days}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs text-muted-foreground sm:max-w-64">
                Computer
                <select
                  aria-label="Repeated input computer"
                  className={SELECT_CLASS}
                  value={environmentId}
                  onChange={(event) => setEnvironmentId(event.target.value)}
                >
                  <option value="all">All computers</option>
                  {environments.map((entry) => (
                    <option key={entry.environmentId} value={entry.environmentId}>
                      {entry.label}
                    </option>
                  ))}
                  {environmentId !== "all" &&
                  !environments.some((entry) => entry.environmentId === environmentId) ? (
                    <option value={environmentId}>Disconnected computer</option>
                  ) : null}
                </select>
              </label>
              <Button
                variant="outline"
                className="min-h-11"
                aria-label="Refresh repeated input"
                aria-busy={pending}
                disabled={pending}
                onClick={refreshWindow}
              >
                <RefreshCwIcon aria-hidden className="size-4" />
                <span className="hidden sm:inline">Refresh</span>
              </Button>
              <p className="basis-full text-xs text-muted-foreground sm:ml-auto sm:basis-auto sm:pb-3">
                {formatDayShort(selection.window.sinceDay)} to{" "}
                {formatDayShort(selection.window.untilDay)}
              </p>
            </div>
          </div>

          {data && incomplete.length > 0 ? (
            <div
              role="status"
              className="rounded-md border border-border bg-muted/20 px-4 py-3 text-sm"
            >
              <p>
                Showing available attribution. Some computers have not returned a complete result.
              </p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {incomplete.map((entry) => (
                  <li key={entry.environmentId}>
                    {entry.label}:{" "}
                    {entry.error ??
                      (entry.isPending
                        ? "Updating"
                        : entry.summary?.repeatedInput
                          ? "Current skill catalog unavailable"
                          : "Attribution unavailable")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {data ? (
            <RepeatedInputSection data={data} />
          ) : (
            <div role="status" className="rounded-lg border border-border px-5 py-10 sm:px-8">
              <h2 className="text-lg font-medium">
                {pending
                  ? "Reading repeated input"
                  : failed
                    ? "Attribution unavailable"
                    : "No attribution available"}
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                {pending
                  ? "Your computers are reading saved transcript metadata for this period."
                  : failed
                    ? "A selected computer could not report usage. Reconnect it and refresh to try again."
                    : selected.length === 0
                      ? "Connect a computer with local Codex history to inspect skills and repeated input."
                      : "The selected computers did not return repeated-input data. Check that their servers support attribution, or select another computer."}
              </p>
            </div>
          )}
        </WorkspacePageContainer>
      </ScrollArea>
    </SidebarInset>
  );
}
