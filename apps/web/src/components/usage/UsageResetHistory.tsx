import type { ContextMenuItem } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import {
  quotaSavedCostPrefix,
  type QuotaEnvironment,
  type QuotaPeriod,
  type QuotaValue,
} from "@t3tools/shared/usageQuota";
import type { MouseEvent as ReactMouseEvent } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import { monitoredModels } from "./usageTokenBudget";

const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const estimate = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);

/** Per-model totals for a period, preferring saved snapshots once live costs have been pruned. */
export function monitoredPeriodModels(
  period: QuotaPeriod,
  value: QuotaValue,
  environments: readonly QuotaEnvironment[],
) {
  const savedPrefix = quotaSavedCostPrefix(period, environments);
  const interval = value.costObservedUntil
    ? (savedPrefix?.interval ?? null)
    : {
        id: period.id,
        sinceTime: period.first.observedAt,
        untilTime: period.last.observedAt,
      };
  if (!interval) return null;
  const modelEnvironments =
    value.costObservedUntil && savedPrefix
      ? environments.map((environment) => ({
          ...environment,
          summary: environment.summary
            ? {
                ...environment.summary,
                quotaCosts: undefined,
                quotaCostSnapshots: savedPrefix.rows,
              }
            : environment.summary,
        }))
      : environments;
  const models = monitoredModels(interval, modelEnvironments);
  return models !== null &&
    models.some((row) => Object.values(row.totals).some((tokens) => tokens > 0))
    ? models
    : null;
}

const inputTokens = (totals: {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
}) => totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens;

/**
 * Completed cycles, newest first. A row opens its cycle in the chart; right-click
 * copies its numbers.
 */
export function UsageResetHistory({
  periods,
  values,
  environments,
  selectedCycle,
  monitoringSince,
  onSelectCycle,
}: {
  readonly periods: readonly QuotaPeriod[];
  readonly values: ReadonlyMap<string, QuotaValue>;
  readonly environments: readonly QuotaEnvironment[];
  readonly selectedCycle: string | null;
  readonly monitoringSince: string;
  readonly onSelectCycle: (cycleId: string | null) => void;
}) {
  if (periods.length < 2) {
    return (
      <p className="text-sm text-muted-foreground">
        No reset observed since {dateTime(monitoringSince)}. Completed cycles appear here with the
        usage left before each reset.
      </p>
    );
  }
  const openMenu = async (event: ReactMouseEvent, period: QuotaPeriod, summary: string) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const items: ContextMenuItem<"chart" | "copy">[] = [
      { id: "chart", label: "Show this cycle in the chart" },
      { id: "copy", label: "Copy cycle summary", icon: "copy" },
    ];
    let action: "chart" | "copy" | null = null;
    try {
      action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
    } catch {
      return;
    }
    if (action === "chart") onSelectCycle(period.id);
    else if (action === "copy") {
      await writeTextToClipboard(summary, "cycle").then(
        () => toastManager.add({ type: "success", title: "Copied cycle summary" }),
        () => toastManager.add({ type: "error", title: "Could not copy the cycle summary" }),
      );
    }
  };
  return (
    <ol className="divide-y divide-border">
      {periods
        .slice(0, -1)
        .toReversed()
        .map((period) => {
          const value = values.get(period.id);
          const models = value ? monitoredPeriodModels(period, value, environments) : null;
          const gap = (period.observationGapMs ?? Infinity) > 60 * 60_000;
          const title = gap
            ? "Window changed across an observation gap"
            : period.resetKind === "ambiguous"
              ? "Usage window changed"
              : "Usage returned";
          const unused =
            period.usedPercentagePoints === 0 && period.resetKind === "ambiguous"
              ? "No quota use observed"
              : gap || value === undefined || value.unusedValueUsd === null
                ? "Unused value not established"
                : `≈ ${estimate(value.unusedValueUsd)} unused`;
          const cost =
            value !== undefined && value.costUsd !== null
              ? `${estimate(value.costUsd)} API value${value.costObservedUntil ? ` through ${dateTime(value.costObservedUntil)}` : ""}`
              : null;
          const summary = `${title}: ${period.last.remainingPercent}% left, ${period.usedPercentagePoints}% used, ${dateTime(period.first.observedAt)} to ${dateTime(period.next!.observedAt)}${cost ? `, ${cost}` : ""}`;
          const selected = selectedCycle === period.id;
          return (
            <li key={period.id} className="py-1.5">
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelectCycle(selected ? null : period.id)}
                onContextMenu={(event) => void openMenu(event, period, summary)}
                className={cn(
                  "flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md px-2 py-2 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring",
                  selected && "bg-muted/40",
                )}
              >
                <span className="min-w-0">
                  <span className="block text-sm">{title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {dateTime(period.first.observedAt)} to {dateTime(period.next!.observedAt)}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block text-sm tabular-nums">
                    {period.last.remainingPercent}% left · {period.usedPercentagePoints}% used
                  </span>
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {[cost, unused].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
              {models ? (
                <details className="mx-2 mt-1 rounded-md border border-border/70 px-3 py-1.5">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Models · {formatTokens(models.reduce((t, m) => t + inputTokens(m.totals), 0))}{" "}
                    input · {formatTokens(models.reduce((t, m) => t + m.totals.outputTokens, 0))}{" "}
                    output
                  </summary>
                  <table
                    className="mt-2 w-full text-left text-xs"
                    aria-label={`Model usage ending ${dateTime(period.last.observedAt)}`}
                  >
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-3 font-normal">Model</th>
                        <th className="px-3 py-1 text-right font-normal">Input</th>
                        <th className="px-3 py-1 text-right font-normal">Output</th>
                        <th className="py-1 pl-3 text-right font-normal">API value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {models.map((model) => (
                        <tr key={model.model} className="border-t border-border/70">
                          <td className="py-1.5 pr-3">{model.model}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {formatTokens(inputTokens(model.totals))}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {formatTokens(model.totals.outputTokens)}
                          </td>
                          <td className="py-1.5 pl-3 text-right tabular-nums">
                            {formatUsd(model.costUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ) : null}
            </li>
          );
        })}
    </ol>
  );
}
