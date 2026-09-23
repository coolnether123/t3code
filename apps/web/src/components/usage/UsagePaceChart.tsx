import {
  quotaActivityPoints,
  quotaPercentCrossings,
  type ChartActivity,
} from "./usageChartActivity";
import { UsageActivityPanel } from "./UsageActivityPanel";
import type { UsageQuotaSample } from "@t3tools/contracts";
import {
  currentResetAnnouncement,
  type ResetNews,
} from "@t3tools/client-runtime/resetAnnouncements";
import { quotaDuration, quotaForecast } from "@t3tools/shared/usageQuotaForecast";
import { quotaHistoryPoints, quotaPeriods } from "@t3tools/shared/usageQuota";
import {
  apiCostPace,
  type ApiPaceInput,
  type ManualResetSummary,
  type PriorApiPaceInput,
} from "./usageApiPace";
import { UsageRunwayPlanner } from "./UsageRunwayPlanner";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
const time = (value: string) =>
  new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
const NO_ACTIVITY: readonly ChartActivity[] = [];

export function UsagePaceChart({
  samples,
  news,
  resetCheck,
  apiPace = null,
  priorApiPace = null,
  manualResets = null,
  selectedCycle: controlledCycle,
  onCycleChange,
  activity = NO_ACTIVITY,
  onRangeChange,
}: {
  readonly activity?: readonly ChartActivity[];
  readonly onRangeChange?: (range: readonly [number, number] | null) => void;
  readonly selectedCycle?: string | null;
  readonly onCycleChange?: (cycleId: string | null) => void;
  readonly samples: readonly UsageQuotaSample[];
  readonly news?: ResetNews;
  readonly resetCheck?: ReactNode;
  readonly apiPace?: ApiPaceInput | null;
  readonly priorApiPace?: PriorApiPaceInput | null;
  readonly manualResets?: ManualResetSummary | null;
}) {
  const [now, setNow] = useState(Date.now);
  const [view, setView] = useState<"forecast" | "observed">("forecast");
  const [showApiPace, setShowApiPace] = useState(true);
  const [inspected, setInspected] = useState<number | null>(null);
  const [pointerX, setPointerX] = useState<number | null>(null);
  const [localCycle, setLocalCycle] = useState<string | null>(null);
  const selectedCycle = controlledCycle === undefined ? localCycle : controlledCycle;
  const [zoom, setZoom] = useState<{
    cycle: string;
    view: string;
    range: readonly [number, number];
  } | null>(null);
  const [drag, setDrag] = useState<readonly [number, number] | null>(null);
  const id = useId();
  const cycles = useMemo(() => quotaPeriods(samples), [samples]);
  const selectedCycleIndex = cycles.findIndex((cycle) => cycle.id === selectedCycle);
  const cycleIndex = selectedCycleIndex < 0 ? cycles.length - 1 : selectedCycleIndex;
  const cycle = cycles[cycleIndex];
  const historical = cycleIndex < cycles.length - 1;
  const cycleSamples = useMemo(
    () =>
      cycle
        ? samples.filter(
            (sample) =>
              sample.observedAt >= cycle.first.observedAt &&
              (cycle.next === null || sample.observedAt < cycle.next.observedAt),
          )
        : [],
    [samples, cycle],
  );
  const chartSamples = useMemo(() => quotaHistoryPoints(cycleSamples), [cycleSamples]);
  useEffect(() => setNow(Date.now()), [samples]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const announced = historical ? null : currentResetAnnouncement(news, samples.at(-1), now);
  const forecast = useMemo(
    () =>
      quotaForecast(
        historical ? cycleSamples : samples,
        historical && cycle ? Date.parse(cycle.last.observedAt) : now,
        3,
        announced?.targetAt,
      ),
    [samples, cycleSamples, cycle, historical, now, announced],
  );
  const activityPoints = useMemo(
    () => quotaActivityPoints(cycleSamples, activity),
    [cycleSamples, activity],
  );
  const crossings = useMemo(() => quotaPercentCrossings(activityPoints), [activityPoints]);
  if (!forecast) return null;
  // Show the whole saved cycle, including earlier monitoring runs. Measurements
  // and cost calibration still use the forecast's active monitoring run.
  const chartStart = Date.parse(chartSamples[0]!.observedAt);
  const chartEnd = Date.parse(forecast.planningResetAt);
  const chartX = (at: number) =>
    Math.max(0, Math.min(1, (at - chartStart) / Math.max(chartEnd - chartStart, 1)));
  const remapX = (x: number) =>
    chartX(
      Date.parse(forecast.first.observedAt) +
        x * (chartEnd - Date.parse(forecast.first.observedAt)),
    );
  const f = {
    ...forecast,
    first: chartSamples[0]!,
    points: activityPoints.map((point) => ({ ...point, x: chartX(Date.parse(point.observedAt)) })),
    observationX: remapX(forecast.observationX),
    projectionEndX: remapX(forecast.projectionEndX),
  };
  const curveBalance = f.points.at(-1)!.remainingPercent;
  const measuredCostPace = historical ? null : apiCostPace(forecast, apiPace, now, priorApiPace);
  const costPace = measuredCostPace
    ? { ...measuredCostPace, projectionEndX: remapX(measuredCostPace.projectionEndX) }
    : null;
  const observed = historical || view === "observed";
  const ending = historical
    ? cycle!.next!.observedAt
    : observed
      ? f.latest.observedAt
      : f.planningResetAt;
  const fullEnd = Math.max(chartStart + 1, Date.parse(ending));
  const activeZoom = zoom?.cycle === cycle!.id && zoom.view === view ? zoom.range : null;
  const viewStart = activeZoom
    ? Math.max(chartStart, Math.min(activeZoom[0], fullEnd - 1))
    : chartStart;
  const viewEnd = activeZoom ? Math.min(fullEnd, Math.max(activeZoom[1], viewStart + 1)) : fullEnd;
  const viewX = (at: number) => (at - viewStart) / (viewEnd - viewStart);
  const pointX = (p: { observedAt: string }) => viewX(Date.parse(p.observedAt));
  const forecastX = (x: number) => viewX(chartStart + x * (chartEnd - chartStart));
  const setRange = (range: readonly [number, number] | null) => {
    setZoom(range ? { cycle: cycle!.id, view, range } : null);
    setInspected(null);
    setPointerX(null);
    onRangeChange?.(range);
  };
  const zoomTo = (
    duration: number,
    center = pointerX === null
      ? Math.min((viewStart + viewEnd) / 2, Date.parse(f.latest.observedAt))
      : chartStart + pointerX * (chartEnd - chartStart),
  ) => {
    const span = Math.min(fullEnd - chartStart, Math.max(60_000, duration));
    const start = Math.max(chartStart, Math.min(fullEnd - span, center - span / 2));
    setRange(span >= fullEnd - chartStart ? null : [start, start + span]);
  };
  const visiblePoints = f.points.filter((point, index) => {
    const at = Date.parse(point.observedAt);
    return (
      (at >= viewStart && at <= viewEnd) ||
      (at < viewStart &&
        Date.parse(f.points[index + 1]?.observedAt ?? point.observedAt) >= viewStart) ||
      (at > viewEnd && Date.parse(f.points[index - 1]?.observedAt ?? point.observedAt) <= viewEnd)
    );
  });
  const yMin =
    activeZoom && visiblePoints.length
      ? Math.max(0, Math.floor(Math.min(...visiblePoints.map((p) => p.remainingPercent)) - 3))
      : 0;
  const yMax =
    activeZoom && visiblePoints.length
      ? Math.min(100, Math.ceil(Math.max(...visiblePoints.map((p) => p.remainingPercent)) + 3))
      : 100;
  const y = (percent: number) => 196 - ((percent - yMin) / Math.max(yMax - yMin, 1)) * 192;
  const tickStep = activeZoom ? (yMax - yMin <= 16 ? 1 : yMax - yMin <= 35 ? 5 : 10) : 25;
  const firstTick = Math.floor(yMax / tickStep) * tickStep;
  const yTicks = Array.from(
    { length: Math.floor((firstTick - yMin) / tickStep) + 1 },
    (_, i) => firstTick - i * tickStep,
  );
  const path = f.points
    .map((p) => `${p.breakBefore ? "M" : "L"}${pointX(p) * 960},${y(p.remainingPercent)}`)
    .join(" ");
  const inspectedPoint =
    inspected === null
      ? (visiblePoints.at(-1) ?? f.points.at(-1)!)
      : f.points[Math.min(inspected, f.points.length - 1)]!;
  const inspectedReading = chartSamples.reduce((best, reading) =>
    Math.abs(Date.parse(reading.observedAt) - Date.parse(inspectedPoint.observedAt)) <
    Math.abs(Date.parse(best.observedAt) - Date.parse(inspectedPoint.observedAt))
      ? reading
      : best,
  );
  const futureFraction =
    pointerX !== null && !observed && pointerX > f.observationX ? pointerX : null;
  const futureAt =
    futureFraction === null
      ? null
      : new Date(
          Date.parse(f.first.observedAt) +
            futureFraction * (Date.parse(f.planningResetAt) - Date.parse(f.first.observedAt)),
        ).toISOString();
  const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
  const targetAtFuture =
    futureFraction === null
      ? null
      : clampPercent(
          curveBalance +
            (f.reserve - curveBalance) *
              ((futureFraction - f.observationX) / Math.max(1 - f.observationX, 1e-9)),
        );
  const blendedAtFuture =
    futureFraction === null
      ? null
      : clampPercent(
          curveBalance +
            (f.projectionEndPercent - curveBalance) *
              ((futureFraction - f.observationX) /
                Math.max(f.projectionEndX - f.observationX, 1e-9)),
        );
  const apiAtFuture =
    futureFraction === null || !showApiPace || !costPace
      ? null
      : clampPercent(
          curveBalance +
            (costPace.projectionEndPercent - curveBalance) *
              ((futureFraction - f.observationX) /
                Math.max(costPace.projectionEndX - f.observationX, 1e-9)),
        );
  const hourly = f.resetInMs < 86_400_000;
  const plotEnd = fullEnd;
  const tickCount = 4;
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => ({
    x: index / tickCount,
    at: new Date(viewStart + ((viewEnd - viewStart) * index) / tickCount),
  }));
  const weeklyStart = Date.parse(f.latest.resetsAt) - 7 * 86_400_000;
  const paceAt = (at: number) =>
    historical
      ? clampPercent(
          f.first.remainingPercent * (1 - (at - chartStart) / Math.max(plotEnd - chartStart, 1)),
        )
      : clampPercent(100 - ((at - weeklyStart) / (7 * 86_400_000)) * 100);
  const paceStartY = y(paceAt(viewStart));
  const paceEndY = y(paceAt(viewEnd));
  const paceDelta = historical
    ? paceAt(Date.parse(f.latest.observedAt)) - f.latest.remainingPercent
    : f.paceDelta;
  const behind = paceDelta > 0;
  const areaPath = f.points
    .flatMap((point, index) => {
      const previous = f.points[index - 1];
      if (!previous || point.breakBefore) return [];
      return [
        `M${pointX(previous) * 960},${y(previous.remainingPercent)} L${pointX(point) * 960},${y(point.remainingPercent)} L${pointX(point) * 960},${y(paceAt(Date.parse(point.observedAt)))} L${pointX(previous) * 960},${y(paceAt(Date.parse(previous.observedAt)))} Z`,
      ];
    })
    .join(" ");
  const selectCycle = (index: number) => {
    const cycleId = index === cycles.length - 1 ? null : cycles[index]!.id;
    setRange(null);
    setLocalCycle(cycleId);
    onCycleChange?.(cycleId);
    setInspected(null);
    setPointerX(null);
  };
  return (
    <section
      aria-label={historical ? "Past Codex usage" : "Current Codex usage"}
      className="min-w-0 rounded-lg border border-border/60 bg-card/20 p-2 sm:p-4"
    >
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-1 sm:mb-2 sm:pb-2">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {historical ? `Cycle ${cycleIndex + 1} of ${cycles.length}` : "Current cycle"}
          <span className="ml-2">
            {new Date(f.first.observedAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
            {historical
              ? ` – ${new Date(f.latest.observedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
              : ""}
          </span>
        </p>
        <div className="flex items-center gap-1" role="group" aria-label="Reset cycle history">
          <button
            type="button"
            aria-label="Previous reset cycle"
            disabled={cycleIndex <= 0}
            onClick={() => selectCycle(cycleIndex - 1)}
            className="inline-flex size-9 items-center justify-center rounded hover:bg-muted disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronLeftIcon className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Next reset cycle"
            disabled={!historical}
            onClick={() => selectCycle(cycleIndex + 1)}
            className="inline-flex size-9 items-center justify-center rounded hover:bg-muted disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronRightIcon className="size-4" />
          </button>
          <button
            type="button"
            disabled={!historical}
            onClick={() => selectCycle(cycles.length - 1)}
            className="min-h-9 rounded px-2 text-xs hover:bg-muted disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-ring"
          >
            Current
          </button>
        </div>
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-[9rem_minmax(0,1fr)]">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 lg:block">
            <h2 className="hidden text-xs font-medium lg:block">Weekly quota</h2>
            <p className="text-2xl lg:mt-2 lg:text-3xl font-medium tracking-tight tabular-nums">
              {f.latest.remainingPercent}%
            </p>
            <p className="text-xs text-muted-foreground">
              remaining{historical || f.stale ? " at last reading" : ""}
            </p>
            <p
              className={`lg:mt-2 inline-flex rounded px-2 py-1 text-[11px] tabular-nums ${behind ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"}`}
            >
              {Math.abs(paceDelta).toFixed(1)} points {behind ? "behind" : "ahead"}
            </p>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px] lg:grid-cols-1 lg:text-xs">
            <div className="flex items-start justify-between gap-2">
              <dt className="text-muted-foreground">
                {historical ? "Reset observed" : "Reset in"}
              </dt>
              <dd className="text-right tabular-nums">
                {historical ? date(cycle!.next!.observedAt) : quotaDuration(f.resetInMs)}
                {!historical ? (
                  <span className="mt-1 hidden text-[10px] text-muted-foreground lg:block">
                    {date(f.planningResetAt)}
                  </span>
                ) : null}
              </dd>
            </div>
            <div className="hidden justify-between gap-2 lg:flex">
              <dt className="text-muted-foreground">Used</dt>
              <dd className="text-right tabular-nums">
                {f.usedPercent}%
                <span className="mt-1 block text-[10px] text-muted-foreground">
                  used this cycle
                </span>
              </dd>
            </div>
            {!historical ? (
              <>
                <div className="hidden justify-between gap-2 lg:flex">
                  <dt className="text-muted-foreground">Daily budget</dt>
                  <dd className="tabular-nums">{f.recommendedPercentPerDay.toFixed(1)}%</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">API / hour</dt>
                  <dd className="tabular-nums">
                    {costPace ? formatUsd(costPace.usdPerHour) : "Learning"}
                  </dd>
                </div>
              </>
            ) : (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Readings</dt>
                <dd className="tabular-nums">{chartSamples.length}</dd>
              </div>
            )}
            {!historical ? (
              <div className="hidden justify-between gap-2 lg:flex">
                <dt className="text-muted-foreground">Banked resets</dt>
                <dd className="tabular-nums">
                  {manualResets?.verified ? manualResets.availableCount : "Unknown"}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              className="hidden flex-wrap gap-x-4 gap-y-2 text-[11px] text-muted-foreground sm:flex"
              aria-label="Chart legend"
            >
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={`w-3 border-t-2 ${behind ? "border-red-500" : "border-emerald-500"}`}
                />
                {activityPoints.some((point) => point.estimated)
                  ? "API-weighted estimate"
                  : "Recorded"}
              </span>
              {!observed ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 border-t-2 border-dashed border-amber-500" />
                  Forecast
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 border-t border-dashed border-muted-foreground" />
                Pace
              </span>
              {!observed && showApiPace && costPace ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 border-t border-dashed border-cyan-500" />
                  API
                </span>
              ) : null}
            </div>
            {!historical ? (
              <div
                className="flex rounded-md bg-muted/60 p-0.5"
                role="group"
                aria-label="Chart view"
              >
                {(
                  [
                    ["observed", "Recorded"],
                    ["forecast", "To reset"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={view === value}
                    onClick={() => {
                      setRange(null);
                      setView(value);
                      setPointerX(null);
                    }}
                    className={`min-h-9 rounded px-2.5 text-xs focus-visible:outline-2 focus-visible:outline-ring ${view === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <span className="text-[11px] text-muted-foreground">Saved cycle</span>
            )}
          </div>
          <div
            className="mt-3 flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Graph zoom"
          >
            {(
              [
                ["Full cycle", null],
                ["24h", 86_400_000],
                ["6h", 21_600_000],
                ["1h", 3_600_000],
              ] as const
            ).map(([label, duration]) => (
              <button
                key={label}
                type="button"
                onClick={() =>
                  duration === null
                    ? setRange(null)
                    : zoomTo(
                        duration,
                        Math.min(viewEnd, Date.parse(f.latest.observedAt)) - duration / 2,
                      )
                }
                aria-pressed={
                  duration === null ? !activeZoom : Math.abs(viewEnd - viewStart - duration) < 1
                }
                className="min-h-9 rounded px-2 text-xs text-muted-foreground hover:bg-muted aria-pressed:bg-muted aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                {label}
              </button>
            ))}
            <div className="flex items-center">
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => zoomTo((viewEnd - viewStart) / 2)}
                className="min-h-9 min-w-9 rounded text-sm hover:bg-muted"
              >
                +
              </button>
              <button
                type="button"
                aria-label="Zoom out"
                disabled={!activeZoom}
                onClick={() => zoomTo((viewEnd - viewStart) * 2)}
                className="min-h-9 min-w-9 rounded text-sm hover:bg-muted disabled:opacity-30"
              >
                −
              </button>
              <button
                type="button"
                aria-label="Pan earlier"
                disabled={!activeZoom || viewStart <= chartStart}
                onClick={() =>
                  zoomTo(viewEnd - viewStart, (viewStart + viewEnd) / 2 - (viewEnd - viewStart) / 2)
                }
                className="inline-flex size-9 items-center justify-center rounded hover:bg-muted disabled:opacity-30"
              >
                <ChevronLeftIcon className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Pan later"
                disabled={!activeZoom || viewEnd >= fullEnd}
                onClick={() =>
                  zoomTo(viewEnd - viewStart, (viewStart + viewEnd) / 2 + (viewEnd - viewStart) / 2)
                }
                className="inline-flex size-9 items-center justify-center rounded hover:bg-muted disabled:opacity-30"
              >
                <ChevronRightIcon className="size-4" />
              </button>
            </div>
            <span className="hidden text-[10px] text-muted-foreground sm:inline">
              Drag to zoom · double-click to reset
            </span>
          </div>
          {activeZoom ? (
            <p className="mt-1 text-[10px] text-muted-foreground" aria-label="Visible chart range">
              {date(new Date(viewStart).toISOString())} to {date(new Date(viewEnd).toISOString())}
            </p>
          ) : null}
          <p
            role="status"
            className={`mt-2 text-right text-[10px] ${f.stale ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
          >
            {historical ? "Last reading" : f.stale ? "Reading is stale" : "Updated"} ·{" "}
            {date(f.latest.observedAt)}
          </p>
          <div className="mt-2 flex gap-2">
            <div
              aria-hidden
              className="relative h-28 sm:h-[clamp(7rem,18dvh,9rem)] w-9 shrink-0 text-[10px] text-muted-foreground tabular-nums"
            >
              {yTicks.map((p) => (
                <span
                  key={p}
                  className="absolute right-0 -translate-y-1/2"
                  style={{ top: `${y(p) / 2}%` }}
                >
                  {Number(p.toFixed(1))}%
                </span>
              ))}
            </div>
            <div className="relative h-28 sm:h-[clamp(7rem,18dvh,9rem)] min-w-0 flex-1 overflow-hidden">
              <svg
                viewBox="0 0 960 200"
                preserveAspectRatio="none"
                className="h-full w-full touch-pan-y select-none outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                role="img"
                tabIndex={0}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  const fraction = Math.max(
                    0,
                    Math.min(1, (event.clientX - rect.left) / rect.width),
                  );
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const at = viewStart + fraction * (viewEnd - viewStart);
                  setPointerX(chartX(at));
                  setInspected(
                    f.points.reduce(
                      (best, point, index) =>
                        Math.abs(Date.parse(point.observedAt) - at) <
                        Math.abs(Date.parse(f.points[best]!.observedAt) - at)
                          ? index
                          : best,
                      0,
                    ),
                  );
                  setDrag([fraction, fraction]);
                }}
                onPointerMove={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const fraction = Math.max(
                    0,
                    Math.min(1, (event.clientX - rect.left) / rect.width),
                  );
                  const at = viewStart + fraction * (viewEnd - viewStart);
                  setPointerX(chartX(at));
                  if (drag) setDrag([drag[0], fraction]);
                  setInspected(
                    f.points.reduce(
                      (best, point, index) =>
                        Math.abs(Date.parse(point.observedAt) - at) <
                        Math.abs(Date.parse(f.points[best]!.observedAt) - at)
                          ? index
                          : best,
                      0,
                    ),
                  );
                }}
                onPointerUp={() => {
                  if (drag && Math.abs(drag[1] - drag[0]) > 0.015) {
                    const start = viewStart + Math.min(...drag) * (viewEnd - viewStart);
                    const end = viewStart + Math.max(...drag) * (viewEnd - viewStart);
                    zoomTo(end - start, (start + end) / 2);
                  }
                  setDrag(null);
                }}
                onPointerCancel={() => setDrag(null)}
                onDoubleClick={() => setRange(null)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setRange(null);
                    return;
                  }
                  if (event.key === "+" || event.key === "=") {
                    event.preventDefault();
                    zoomTo((viewEnd - viewStart) / 2);
                    return;
                  }
                  if (event.key === "-") {
                    event.preventDefault();
                    zoomTo((viewEnd - viewStart) * 2);
                    return;
                  }
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  setPointerX(null);
                  const delta = event.key === "ArrowLeft" ? -1 : 1;
                  const visibleIndices = f.points.flatMap((point, index) =>
                    pointX(point) >= 0 && pointX(point) <= 1 ? [index] : [],
                  );
                  const firstVisible = visibleIndices[0] ?? 0;
                  const lastVisible = visibleIndices.at(-1) ?? f.points.length - 1;
                  setInspected((current) =>
                    Math.max(firstVisible, Math.min(lastVisible, (current ?? lastVisible) + delta)),
                  );
                }}
                aria-label={
                  observed
                    ? "Recorded Codex remaining usage"
                    : "Codex remaining usage and pace to next reset"
                }
              >
                <desc>
                  Solid: fractional estimates between whole-percent changes when costs are
                  available, green ahead of pace and red behind it. Dotted horizontal guides mark
                  whole percentages; markers show estimated crossings. Gray dashed diagonal:
                  {historical
                    ? " even pace to the observed reset."
                    : " even weekly pace. Orange: blended projection."}
                  {showApiPace && costPace && !observed ? " Cyan: API cost projection." : ""}
                  {
                    " Missing costs use straight lines across tracking gaps; reset changes remain separate."
                  }
                </desc>
                {yTicks.map((percent) => (
                  <line
                    key={percent}
                    aria-label={`${percent}% guide`}
                    x1={0}
                    x2={960}
                    y1={y(percent)}
                    y2={y(percent)}
                    stroke="currentColor"
                    className="text-border/50"
                    strokeDasharray={activeZoom ? "2 5" : undefined}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <defs>
                  <clipPath id={`${id}-ahead`}>
                    <path d={`M0,0 H960 V${paceEndY} L0,${paceStartY} Z`} />
                  </clipPath>
                  <clipPath id={`${id}-behind`}>
                    <path d={`M0,${paceStartY} L960,${paceEndY} V200 H0 Z`} />
                  </clipPath>
                </defs>
                {["ahead", "behind"].map((side) => (
                  <path
                    key={`fill-${side}`}
                    aria-label={side === "ahead" ? "Ahead of pace area" : "Behind pace area"}
                    d={areaPath}
                    clipPath={`url(#${id}-${side})`}
                    fill="currentColor"
                    className={side === "ahead" ? "text-emerald-500/15" : "text-red-500/15"}
                  />
                ))}
                {ticks.map((tick) => (
                  <line
                    key={tick.x}
                    x1={tick.x * 960}
                    x2={tick.x * 960}
                    y1={4}
                    y2={196}
                    stroke="currentColor"
                    className="text-border/50"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <line
                  aria-label={historical ? "Pace to observed reset" : "Weekly pace"}
                  x1={0}
                  y1={paceStartY}
                  x2={960}
                  y2={paceEndY}
                  stroke="currentColor"
                  className="text-muted-foreground/70"
                  strokeDasharray="3 5"
                  vectorEffect="non-scaling-stroke"
                />
                {historical ? (
                  <line
                    aria-label="Observed reset boundary"
                    x1={viewX(fullEnd) * 960}
                    x2={viewX(fullEnd) * 960}
                    y1={4}
                    y2={196}
                    stroke="currentColor"
                    className="text-muted-foreground/60"
                    strokeDasharray="2 4"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null}
                {!observed ? (
                  <>
                    {showApiPace && costPace ? (
                      <path
                        aria-label="API cost projection"
                        d={`M${forecastX(f.observationX) * 960},${y(curveBalance)} L${forecastX(costPace.projectionEndX) * 960},${y(costPace.projectionEndPercent)} L${forecastX(1) * 960},${y(costPace.projectionEndPercent)}`}
                        fill="none"
                        stroke="#52b8bf"
                        strokeWidth={2}
                        strokeDasharray="3 3"
                        vectorEffect="non-scaling-stroke"
                      />
                    ) : null}
                    <line
                      x1={forecastX(f.observationX) * 960}
                      y1={y(curveBalance)}
                      x2={forecastX(f.projectionEndX) * 960}
                      y2={y(f.projectionEndPercent)}
                      stroke="#d88d42"
                      strokeWidth={2}
                      strokeDasharray="7 4"
                      vectorEffect="non-scaling-stroke"
                    />
                  </>
                ) : null}
                {["ahead", "behind"].map((side) => (
                  <path
                    key={side}
                    aria-label={`Recorded usage ${side} of pace`}
                    d={path}
                    fill="none"
                    stroke="currentColor"
                    className={
                      side === "ahead"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-500 dark:text-red-400"
                    }
                    clipPath={`url(#${id}-${side})`}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <line
                  x1={pointX(inspectedPoint) * 960}
                  x2={pointX(inspectedPoint) * 960}
                  y1={4}
                  y2={196}
                  stroke="currentColor"
                  className="text-muted-foreground/30"
                  strokeDasharray="2 4"
                  vectorEffect="non-scaling-stroke"
                />
                {drag ? (
                  <rect
                    x={Math.min(...drag) * 960}
                    width={Math.abs(drag[1] - drag[0]) * 960}
                    y={0}
                    height={200}
                    className="fill-primary/10 stroke-primary/50"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null}
              </svg>
              {activeZoom
                ? crossings
                    .filter((crossing) => crossing.at >= viewStart && crossing.at <= viewEnd)
                    .map((crossing) => (
                      <span
                        key={crossing.at + ":" + crossing.percent}
                        aria-label={
                          "Estimated " +
                          crossing.percent +
                          "% crossing at " +
                          date(new Date(crossing.at).toISOString())
                        }
                        className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/60 ring-2 ring-background/70"
                        style={{
                          left: viewX(crossing.at) * 100 + "%",
                          top: y(crossing.percent) / 2 + "%",
                        }}
                      />
                    ))
                : null}

              <span
                aria-hidden
                className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
                style={{
                  left: `${pointX(inspectedPoint) * 100}%`,
                  top: `${y(inspectedPoint.remainingPercent) / 2}%`,
                }}
              />
            </div>
          </div>
          <div
            className="relative ml-11 mt-2 h-5 text-[10px] text-muted-foreground tabular-nums"
            aria-hidden="true"
          >
            {ticks.map((tick, index) => (
              <span
                key={tick.x}
                className={`absolute whitespace-nowrap ${index % 2 === 1 ? "hidden sm:block" : ""}`}
                style={{
                  left: `${tick.x * 100}%`,
                  transform:
                    index === 0
                      ? "none"
                      : index === tickCount
                        ? "translateX(-100%)"
                        : "translateX(-50%)",
                }}
              >
                {viewEnd - viewStart < 86_400_000
                  ? time(tick.at.toISOString())
                  : viewEnd - viewStart < 3 * 86_400_000
                    ? tick.at.toLocaleString(undefined, { weekday: "short", hour: "numeric" })
                    : tick.at.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
              </span>
            ))}
          </div>
          <span
            role="status"
            className="pointer-events-none mt-1 block min-h-4 text-[11px] text-muted-foreground tabular-nums"
          >
            {futureAt
              ? `Projection ${date(futureAt)} · target ${targetAtFuture!.toFixed(0)}% · blended ${blendedAtFuture!.toFixed(0)}%${apiAtFuture === null ? "" : ` · API ${apiAtFuture.toFixed(0)}%`}`
              : `${inspectedPoint.provisional ? "Provisional API estimate" : inspectedPoint.estimated ? "Estimated from API activity" : "Recorded"} ${date(inspectedPoint.observedAt)} · ${inspectedPoint.estimated ? inspectedPoint.remainingPercent.toFixed(2) : inspectedPoint.remainingPercent}% remaining`}
          </span>
          <UsageActivityPanel
            activity={activity}
            points={activityPoints}
            start={viewStart}
            end={Math.min(viewEnd, Date.parse(f.latest.observedAt))}
            plotEnd={viewEnd}
            onZoom={(start, end) => zoomTo(Math.max(60_000, (end - start) * 3), (start + end) / 2)}
          />
        </div>
      </div>
      {!historical && f.stale ? (
        <p role="alert" className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          No fresh reading. Forecasts use the last saved balance.
        </p>
      ) : null}
      {!historical && f.historicalPace ? (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          Provisional pace uses the completed cycle from {date(f.historicalPace.since)} through{" "}
          {date(f.historicalPace.until)} while this cycle warms.
        </p>
      ) : null}
      <div className="flex flex-wrap items-start gap-x-6">
        <details className="mt-2 min-w-0 border-t border-border/60 pt-0 open:basis-full">
          <summary className="min-h-8 cursor-pointer content-center text-xs text-muted-foreground hover:text-foreground">
            {historical ? "Inspect saved readings" : "Forecast details & readings"}
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            API costs distribute each confirmed percentage drop across the time since the previous
            drop. Dotted guides show whole percentages and small markers show estimated crossings.
            The unfinished percent uses the previous drop's cost provisionally, capped within one
            point of the last reading. Missing costs use straight connections; resets remain
            separate.
          </p>
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="min-h-9 cursor-pointer content-center">
              Inspect recorded readings
            </summary>
            <div className="flex flex-wrap items-center gap-3 pb-3">
              <input
                type="range"
                aria-label="Inspect recorded usage"
                className="min-w-32 flex-1 accent-current"
                min={0}
                max={Math.max(0, chartSamples.length - 1)}
                value={chartSamples.indexOf(inspectedReading)}
                onChange={(event) =>
                  setInspected(
                    f.points.findIndex(
                      (point) =>
                        point.observedAt === chartSamples[Number(event.target.value)]!.observedAt,
                    ),
                  )
                }
              />
              <output className="font-mono tabular-nums">
                {date(inspectedReading.observedAt)} · {inspectedReading.remainingPercent}% remaining
              </output>
            </div>
          </details>
          {!historical ? (
            <>
              {!observed ? (
                <div className="mt-2">
                  <label className="flex min-h-11 w-fit cursor-pointer items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      aria-label="Show API cost pace"
                      className="size-4 accent-[#52b8bf]"
                      checked={showApiPace}
                      onChange={(event) => setShowApiPace(event.target.checked)}
                    />
                    <span style={{ color: "#52b8bf" }}>┄ API cost pace</span>
                  </label>
                  {showApiPace ? (
                    <p role="status" className="text-xs leading-relaxed text-muted-foreground">
                      {costPace
                        ? `${costPace.provisional ? "Provisional: " : ""}${formatUsd(costPace.usdPerHour)}/hour ${costPace.provisional ? `over its ${costPace.hours.toFixed(1)}-hour source interval` : `over the last ${costPace.hours.toFixed(1)} hours`}, including idle time. ${formatUsd(costPace.remainingValueUsd)} estimated at the last reading.${costPace.provisional ? ` Source cycle: ${date(costPace.sourceSince)} to ${date(costPace.sourceUntil)}.` : ""} ${costPace.exhaustionInMs === null ? "No spending in this interval; no exhaustion time projected." : costPace.exhaustsBeforeReset ? `Empty in ${quotaDuration(costPace.exhaustionInMs)} if this spending rate continues.` : `About ${formatUsd(costPace.remainingAtResetUsd)} left at reset.`}`
                        : f.historicalPace
                          ? `Current API burn is warming. The chart's orange pace uses the completed cycle from ${date(f.historicalPace.since)} through ${date(f.historicalPace.until)} as a provisional baseline.`
                          : f.stale
                            ? "API cost pace needs a fresh account reading."
                            : "API cost pace needs at least an hour of monitored history and complete, priced costs for the same interval and remaining balance."}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {showApiPace && !observed && costPace ? (
                <dl className="mt-4 grid grid-cols-2 gap-4 rounded-lg border border-border p-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">API spending rate</dt>
                    <dd className="mt-1 font-mono text-lg">
                      {formatUsd(costPace.usdPerHour)} / hour
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">API value runs out</dt>
                    <dd className="mt-1 text-sm">
                      {costPace.exhaustionAt ? date(costPace.exhaustionAt) : "No spending recorded"}
                    </dd>
                  </div>
                </dl>
              ) : null}
              <dl className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-x-5 gap-y-5 border-t border-border pt-5 [&>div]:min-w-0">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {f.stale ? "Last run-out estimate" : "Blended quota pace"}
                  </dt>
                  <dd className="mt-1 text-lg font-medium tabular-nums">
                    {f.exhaustsBeforeReset
                      ? f.exhaustionInMs === null
                        ? "No burn recorded"
                        : `${quotaDuration(f.exhaustionInMs)} to empty`
                      : `${f.remainingAtReset.toFixed(0)}% left at reset`}
                  </dd>
                  <dd className="mt-1 text-xs text-muted-foreground">
                    {f.exhaustsBeforeReset ? "Runs out before reset" : "Reset comes first"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Pace to reset</dt>
                  <dd className="mt-1 text-lg font-medium tabular-nums">
                    {(hourly
                      ? f.recommendedPercentPerDay / 24
                      : f.recommendedPercentPerDay
                    ).toFixed(1)}
                    % / {hourly ? "hour" : "day"}
                  </dd>
                  <dd className="mt-1 text-xs text-muted-foreground">
                    To leave {f.reserve}% unused
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Blended burn</dt>
                  <dd className="mt-1 tabular-nums">
                    {(f.expectedPercentPerDay / 24).toFixed(2)}% / hour
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Quota runs out</dt>
                  <dd className="mt-1 text-sm">
                    {f.exhaustionAt ? date(f.exhaustionAt) : "No burn recorded"}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                The monitor captured a {f.monitoredUsedPercent}-point drop since{" "}
                {date(forecast.first.observedAt)}.
                {f.usedBeforeMonitoring > 0
                  ? ` You had already used ${f.usedBeforeMonitoring}% when it started.`
                  : " It started at 100%."}
              </p>
              <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                Orange blends monitored usage with the weekly average. Blue spends the estimated
                remaining API value at the average dollar rate from the last six hours, or since
                monitoring began if newer. Its height uses the same remaining-percentage scale. It
                includes idle time and stops at zero. Model changes can affect Codex allowance
                differently, so this remains an estimate.
              </p>
              <div className="mt-6 border-y border-border py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 className="text-sm font-medium">
                    {f.usesAnnouncement ? "Announced reset" : "Weekly reset"}
                  </h2>
                  <span className="text-lg font-medium tabular-nums">
                    {quotaDuration(f.resetInMs)} left
                  </span>
                </div>
                <p className="mt-1 text-sm">{date(f.planningResetAt)}</p>
                {announced ? (
                  <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {f.usesAnnouncement
                      ? "Planning uses the earlier announced time. "
                      : "Announced time passed. Waiting for an account reading to confirm a reset. "}
                    <a
                      className="underline underline-offset-4"
                      href={announced.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Tibo's post
                    </a>
                    {" via "}
                    <a
                      className="underline underline-offset-4"
                      href="https://resetbeacon.com/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Reset Beacon
                    </a>
                    .
                    <details className="mt-1">
                      <summary className="min-h-11 cursor-pointer content-center">
                        Source and weekly timer
                      </summary>
                      <p className="pb-2">
                        {announced.quote} The feed interprets Pacific local time. Announcement
                        timing is not account confirmation.
                      </p>
                      <p>Account weekly timer: {date(f.latest.resetsAt)}.</p>
                    </details>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {news?.status === "loading"
                      ? "Checking reset announcements…"
                      : news?.status === "unavailable"
                        ? "Reset news unavailable. Using your account's weekly timer."
                        : "No earlier reset announcement available."}
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              The reset was observed between {date(cycle!.last.observedAt)} and{" "}
              {date(cycle!.next!.observedAt)}. The exact reset time was not recorded.
            </p>
          )}
        </details>
        {!observed ? (
          <details className="mt-2 min-w-0 border-t border-border/60 open:basis-full">
            <summary className="min-h-8 cursor-pointer content-center text-xs text-muted-foreground hover:text-foreground">
              Runway plan
            </summary>
            <UsageRunwayPlanner
              pace={costPace}
              scheduledResetAt={f.latest.resetsAt}
              manualResets={manualResets}
              now={now}
            />
          </details>
        ) : null}
        {resetCheck}
      </div>
    </section>
  );
}
