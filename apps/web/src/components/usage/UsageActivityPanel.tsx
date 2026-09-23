import { useMemo, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { formatUsd } from "@t3tools/shared/usageFormat";
import {
  estimatedQuotaDrop,
  visibleChartActivity,
  type ChartActivity,
  type quotaActivityPoints,
} from "./usageChartActivity";

const date = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const time = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const modelColor = (model: string) =>
  /astra/i.test(model)
    ? "#8b5cf6"
    : /sol/i.test(model)
      ? "#0891b2"
      : /terra/i.test(model)
        ? "#d97706"
        : /luna/i.test(model)
          ? "#059669"
          : "#64748b";

export function UsageActivityPanel({
  activity,
  points,
  start,
  end,
  plotEnd,
  onZoom,
}: {
  readonly activity: readonly ChartActivity[];
  readonly points: ReturnType<typeof quotaActivityPoints>;
  readonly start: number;
  readonly end: number;
  readonly plotEnd: number;
  readonly onZoom: (start: number, end: number) => void;
}) {
  const [view, setView] = useState<"intensity" | "models" | "spikes">("intensity");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const data = useMemo(() => visibleChartActivity(activity, start, end), [activity, start, end]);
  const selected = data.bins.find((bin) => bin.id === selectedId) ?? data.ranked[0];
  const selectedIndex = selected ? data.bins.indexOf(selected) : -1;
  const quotaDrop = selected ? estimatedQuotaDrop(points, selected.start, selected.end) : null;
  const peakRate = Math.max(1, data.peak?.perHour ?? 0);
  const x = (at: number) => ((at - start) / Math.max(1, plotEnd - start)) * 960;
  const inspectAt = (clientX: number, rect: DOMRect) => {
    const at =
      start + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (plotEnd - start);
    const bin = data.bins.find((bin) => at >= bin.start && at <= bin.end);
    if (bin) setSelectedId(bin.id);
  };
  if (activity.length === 0) return null;
  return (
    <section
      className="mt-2 border-t border-border/60 pt-2 text-xs"
      aria-label="API activity in visible range"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Where usage went</h3>
        <div className="flex rounded-md bg-muted/60 p-0.5" role="group" aria-label="Activity view">
          {(
            [
              ["intensity", "Intensity"],
              ["models", "Models"],
              ["spikes", "Spikes"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
              className="min-h-11 rounded px-3 text-xs text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <dl className="mt-1 grid grid-cols-3 gap-2 tabular-nums">
        <div>
          <dt className="text-[10px] text-muted-foreground">API value in view</dt>
          <dd className="mt-1 text-sm font-medium">
            {data.complete ? formatUsd(data.cost) : "Reading activity…"}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] text-muted-foreground">Average / hour</dt>
          <dd className="mt-1 text-sm font-medium">
            {data.averagePerHour === null ? "—" : formatUsd(data.averagePerHour)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] text-muted-foreground">Peak vs average</dt>
          <dd className="mt-1 text-sm font-medium">
            {data.averagePerHour && data.peak
              ? `${(data.peak.perHour / data.averagePerHour).toFixed(1)}×`
              : "—"}
          </dd>
        </div>
      </dl>
      <div className="mt-2 grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(12rem,1fr)]">
        <div className="min-w-0">
          {view === "spikes" ? (
            <div className="divide-y divide-border/60" aria-label="Highest spending intervals">
              {data.ranked
                .filter((bin) => bin.cost !== null && bin.cost > 0)
                .slice(0, 3)
                .map((bin, index) => (
                  <button
                    key={bin.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(bin.id);
                      setView("intensity");
                    }}
                    className="flex min-h-12 w-full items-center gap-3 py-2 text-left hover:bg-muted/40"
                  >
                    <span className="w-4 text-muted-foreground">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block">{date(bin.start)}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {bin.models[0]?.[0] ?? "No model activity"}
                      </span>
                    </span>
                    <span className="text-right tabular-nums">
                      <span className="block">{formatUsd(bin.cost!)}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {formatUsd(bin.perHour!)} / hour
                      </span>
                    </span>
                  </button>
                ))}
              {data.complete && data.cost === 0 ? (
                <p className="py-4 text-muted-foreground">
                  No API spending recorded in this range.
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <div className="mt-1">
                <svg
                  viewBox="0 0 960 90"
                  preserveAspectRatio="none"
                  className="h-16 w-full touch-pan-y"
                  role="img"
                  aria-label={
                    view === "models" ? "API spending by model over time" : "API spending intensity"
                  }
                  onPointerDown={(event) =>
                    inspectAt(event.clientX, event.currentTarget.getBoundingClientRect())
                  }
                  onPointerMove={(event) => {
                    if (event.buttons === 1)
                      inspectAt(event.clientX, event.currentTarget.getBoundingClientRect());
                  }}
                >
                  {data.bins.map((bin) => {
                    const width = Math.max(0.5, x(bin.end) - x(bin.start) - 1);
                    if (bin.cost === null)
                      return (
                        <rect
                          key={bin.id}
                          x={x(bin.start)}
                          width={width}
                          y={84}
                          height={6}
                          className="fill-muted-foreground/25"
                        />
                      );
                    const height = ((bin.perHour ?? 0) / peakRate) * 82;
                    let used = 0;
                    return (
                      <g key={bin.id} opacity={selected?.id === bin.id ? 1 : 0.65}>
                        {view === "models" ? (
                          bin.models.map(([model, cost]) => {
                            const h = bin.cost! > 0 ? (height * cost) / bin.cost! : 0;
                            used += h;
                            return (
                              <rect
                                key={model}
                                x={x(bin.start)}
                                width={width}
                                y={90 - used}
                                height={h}
                                fill={modelColor(model)}
                              />
                            );
                          })
                        ) : (
                          <rect
                            x={x(bin.start)}
                            width={width}
                            y={90 - height}
                            height={height}
                            className="fill-cyan-600 dark:fill-cyan-400"
                          />
                        )}
                        {selected?.id === bin.id ? (
                          <rect
                            x={x(bin.start)}
                            width={width}
                            y={0}
                            height={90}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1}
                            vectorEffect="non-scaling-stroke"
                          />
                        ) : null}
                      </g>
                    );
                  })}
                </svg>
                <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                  <span>{time(start)}</span>
                  <span>{time(plotEnd)}</span>
                </div>
              </div>
              <p className="sr-only">
                Tap a bar or move the slider to inspect. Bars use the same time range as the quota
                graph.
              </p>
              {data.bins.length > 0 ? (
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Previous activity interval"
                    disabled={selectedIndex <= 0}
                    onClick={() => setSelectedId(data.bins[selectedIndex - 1]!.id)}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded hover:bg-muted disabled:opacity-30"
                  >
                    <ChevronLeftIcon className="size-4" />
                  </button>
                  <input
                    type="range"
                    aria-label="Inspect API activity"
                    min={0}
                    max={data.bins.length - 1}
                    value={Math.max(0, selectedIndex)}
                    onChange={(event) => setSelectedId(data.bins[Number(event.target.value)]!.id)}
                    className="h-11 min-w-0 flex-1 accent-current"
                  />
                  <button
                    type="button"
                    aria-label="Next activity interval"
                    disabled={selectedIndex >= data.bins.length - 1}
                    onClick={() => setSelectedId(data.bins[selectedIndex + 1]!.id)}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded hover:bg-muted disabled:opacity-30"
                  >
                    <ChevronRightIcon className="size-4" />
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
        {data.complete ? (
          <div className="min-w-0 space-y-2" aria-label="Model cost shares">
            <h4 className="text-[10px] text-muted-foreground">Top models / hour</h4>
            {data.models
              .filter(([, cost]) => cost > 0)
              .slice(0, 4)
              .map(([model, cost]) => (
                <div key={model}>
                  <div className="flex justify-between gap-2">
                    <span className="min-w-0 truncate text-[10px] sm:text-xs" aria-label={model}>
                      {model.replace(/^gpt-/, "")}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums sm:text-xs">
                      {formatUsd(
                        data.cost > 0 ? ((data.averagePerHour ?? 0) * cost) / data.cost : 0,
                      )}
                      <span className="hidden text-[10px] text-muted-foreground sm:inline">
                        {" "}
                        · {data.cost > 0 ? Math.round((cost / data.cost) * 100) : 0}%
                      </span>
                    </span>
                  </div>
                  <div className="mt-1 h-1 rounded bg-muted">
                    <div
                      className="h-1 rounded"
                      style={{
                        width: `${data.cost > 0 ? (cost / data.cost) * 100 : 0}%`,
                        backgroundColor: modelColor(model),
                      }}
                    />
                  </div>
                </div>
              ))}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-x-3">
        {selected ? (
          <details
            className="mt-1 border-t border-border/40"
            aria-label="Selected activity interval"
            aria-live="polite"
          >
            <summary className="min-h-9 cursor-pointer content-center text-[10px] text-muted-foreground">
              Inspect interval ·{" "}
              {selected.cost === null ? "Costs unavailable" : formatUsd(selected.cost)}
            </summary>
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="text-[11px]">
                {date(selected.start)} to {time(selected.end)}
              </span>
              <button
                type="button"
                className="min-h-11 rounded px-2 text-xs font-medium hover:bg-muted"
                onClick={() => onZoom(selected.start, selected.end)}
              >
                Zoom here
              </button>
            </div>
            <p className="tabular-nums">
              {selected.cost === null
                ? "Costs unavailable for this interval"
                : `${formatUsd(selected.cost)} API value · ${formatUsd(selected.perHour!)} / hour`}
            </p>
            {quotaDrop !== null ? (
              <p className="mt-1 text-[10px] text-muted-foreground">
                ≈ {quotaDrop.toFixed(2)} quota points used. Estimated between readings.
              </p>
            ) : null}
            {selected.cost !== null ? (
              <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                {selected.models.slice(0, 3).map(([model, cost]) => (
                  <div key={model} className="flex justify-between gap-2">
                    <span className="truncate">{model}</span>
                    <span className="shrink-0 tabular-nums">{formatUsd(cost)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </details>
        ) : null}
        {data.complete && data.models.length > 4 ? (
          <details className="mt-1 text-[10px] text-muted-foreground">
            <summary className="min-h-8 cursor-pointer content-center">All models</summary>
            <div className="space-y-2 pb-2" aria-label="All model hourly costs">
              {data.models.map(([model, cost]) => (
                <div key={model} className="flex justify-between gap-3">
                  <span>{model}</span>
                  <span className="tabular-nums">
                    {formatUsd(data.cost > 0 ? ((data.averagePerHour ?? 0) * cost) / data.cost : 0)}{" "}
                    / hour
                  </span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <details className="mt-1 text-[10px] text-muted-foreground">
          <summary className="min-h-8 cursor-pointer content-center">Insights & help</summary>
          {data.busiestQuarterShare !== null ? (
            <p className="mt-1 text-[10px] text-muted-foreground">
              The busiest 25% of this time accounted for{" "}
              <span className="font-medium text-foreground">
                {Math.round(data.busiestQuarterShare * 100)}% of API value
              </span>
              .
            </p>
          ) : null}
          <p className="pb-2 leading-relaxed">
            API-equivalent costs come from recorded transcripts. Average includes idle time. Peak
            compares the busiest interval with that average; zooming changes interval size. Account
            readings remain in the saved-readings inspector. Dotted guides mark whole percentages.
            Costs spread each confirmed whole-percent drop across time; the unfinished fraction uses
            the previous drop provisionally. Missing costs keep a straight line. Partial intervals
            are prorated. Model costs help locate expensive work but do not measure productivity or
            exact subscription usage.
          </p>
        </details>
      </div>
    </section>
  );
}
