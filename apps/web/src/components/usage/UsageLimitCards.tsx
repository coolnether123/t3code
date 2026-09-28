import type { ContextMenuItem } from "@t3tools/contracts";
import { quotaDuration } from "@t3tools/shared/usageQuotaForecast";
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import {
  hasReadings,
  LIMIT_PROVIDER_NAMES,
  limitWindowSummary,
  type LimitProvider,
  type LimitWindow,
} from "./usageLimitWindows";

const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * One card per subscription limit. Selecting a card charts that limit below;
 * right-click copies its numbers or narrows the page to its provider.
 */
export function UsageLimitCards({
  windows,
  selectedKey,
  onSelect,
  onShowOnly,
}: {
  readonly windows: readonly LimitWindow[];
  readonly selectedKey: string | undefined;
  readonly onSelect: (key: string) => void;
  readonly onShowOnly: (provider: LimitProvider) => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  if (windows.length === 0) return null;

  const openMenu = async (event: ReactMouseEvent, limit: LimitWindow) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const summary = limitWindowSummary(limit, now);
    const name = `${LIMIT_PROVIDER_NAMES[limit.provider]} ${limit.label.toLowerCase()}`;
    type Action = "copy" | "chart" | "only";
    const items: ContextMenuItem<Action>[] = [
      { id: "chart", label: "Chart this limit", disabled: !hasReadings(limit) },
      { id: "copy", label: "Copy remaining and reset", icon: "copy", disabled: summary === null },
      {
        id: "only",
        label: `Show ${LIMIT_PROVIDER_NAMES[limit.provider]} only`,
        separatorBefore: true,
      },
    ];
    let action: Action | null = null;
    try {
      action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
    } catch {
      return;
    }
    if (action === "chart") onSelect(limit.key);
    else if (action === "only") onShowOnly(limit.provider);
    else if (action === "copy" && summary) {
      const text = `${name}: ${summary.remainingPercent}% remaining, resets in ${quotaDuration(summary.resetInMs)} (${new Date(summary.resetsAt).toLocaleString()})`;
      await writeTextToClipboard(text, "limit").then(
        () => toastManager.add({ type: "success", title: "Copied limit" }),
        () => toastManager.add({ type: "error", title: "Could not copy the limit" }),
      );
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Subscription limits"
      className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(11rem,1fr))]"
    >
      {windows.map((limit) => {
        const summary = limitWindowSummary(limit, now);
        const selected = limit.key === selectedKey;
        const behind = (summary?.paceDelta ?? 0) > 0;
        return (
          <button
            key={limit.key}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(limit.key)}
            onContextMenu={(event) => void openMenu(event, limit)}
            className={cn(
              "flex min-h-24 flex-col items-start gap-1 rounded-lg border bg-card/20 p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring",
              selected ? "border-foreground/40 bg-muted/30" : "border-border/60",
            )}
          >
            <span className="flex w-full items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
              <span>{LIMIT_PROVIDER_NAMES[limit.provider]}</span>
              <span className="truncate">{limit.label}</span>
            </span>
            {summary ? (
              <>
                <span className="text-2xl font-medium tabular-nums tracking-tight">
                  {summary.remainingPercent}%
                  <span className="ms-1 text-xs font-normal text-muted-foreground">left</span>
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {summary.stale
                    ? `Last reading ${dateTime(summary.observedAt)}`
                    : `Resets in ${quotaDuration(summary.resetInMs)}`}
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] tabular-nums",
                    behind
                      ? "bg-red-500/10 text-red-600 dark:text-red-400"
                      : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                  )}
                >
                  {Math.abs(summary.paceDelta).toFixed(1)} pts {behind ? "behind" : "ahead"}
                </span>
              </>
            ) : (
              <>
                <span className="text-base text-muted-foreground">Not recorded</span>
                <span className="line-clamp-2 text-[11px] text-muted-foreground">
                  {limit.message ?? "Waiting for the first reading."}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
