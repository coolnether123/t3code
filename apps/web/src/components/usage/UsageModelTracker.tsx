import type { UsageQuotaSample } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import type { QuotaPeriod } from "@t3tools/shared/usageQuota";
import { useId, useMemo, useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { modelDisplayName } from "./UsageModelHourlyChart";
import type { ChartActivity } from "./usageChartActivity";
import { monitoredModels, tokenCount } from "./usageTokenBudget";

type Models = NonNullable<ReturnType<typeof monitoredModels>>;

const COLORS = ["#ed854c", "#62a7ed", "#b897ed", "#67bc9d", "#e4b75e", "#b5b9c0"];
const WIDTH = 960;
const HEIGHT = 208;

const shortTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** An observed percentage drop has no model ledger; API cost supplies the allocation weights. */
export function modelTrackerData(
  period: QuotaPeriod,
  samples: readonly UsageQuotaSample[],
  models: Models,
  activity: readonly ChartActivity[],
) {
  const drop = Math.max(0, period.usedPercentagePoints);
  const totalCost = models.reduce((sum, model) => sum + model.costUsd, 0);
  const start = Date.parse(period.first.observedAt);
  const end = Date.parse(period.last.observedAt);
  const ordered = [...activity].sort((a, b) =>
    a.interval.sinceTime.localeCompare(b.interval.sinceTime),
  );
  let cursor = start;
  let chartCost = 0;
  const allocations = ordered.map(() => new Map<string, number>());
  const rows = (estimated: ReadonlyMap<string, number> | null) =>
    models.map((model) => ({
      ...model,
      share: totalCost > 0 ? model.costUsd / totalCost : 0,
      estimatedPoints: estimated?.get(model.model) ?? null,
    }));
  for (const entry of ordered) {
    const since = Date.parse(entry.interval.sinceTime);
    const until = Date.parse(entry.interval.untilTime);
    if (entry.models === null || since !== cursor || until <= since || until > end) {
      return { rows: rows(null), drop, totalCost, unattributed: null, points: null };
    }
    for (const model of entry.models) {
      chartCost += model.costUsd;
    }
    cursor = until;
  }
  if (cursor !== end || chartCost <= 0 || totalCost <= 0) {
    return { rows: rows(null), drop, totalCost, unattributed: null, points: null };
  }
  // The whole-interval rollup and the chart are separate reads. A different
  // amount means one is stale, so don't draw a convincing but mismatched curve.
  if (Math.abs(chartCost - totalCost) > Math.max(0.01, totalCost * 0.001)) {
    return { rows: rows(null), drop, totalCost, unattributed: null, points: null };
  }
  let unattributed = 0;
  const readings = samples.filter(
    (sample) =>
      sample.observedAt >= period.first.observedAt && sample.observedAt <= period.last.observedAt,
  );
  for (let readingIndex = 1; readingIndex < readings.length; readingIndex++) {
    const first = readings[readingIndex - 1]!;
    const last = readings[readingIndex]!;
    const intervalDrop = Math.max(0, first.remainingPercent - last.remainingPercent);
    if (intervalDrop === 0) continue;
    const from = Date.parse(first.observedAt);
    const to = Date.parse(last.observedAt);
    const overlapping = ordered.map((entry) => {
      const since = Date.parse(entry.interval.sinceTime);
      const until = Date.parse(entry.interval.untilTime);
      const fraction = Math.max(0, Math.min(to, until) - Math.max(from, since)) / (until - since);
      return entry.models!.map((model) => ({ model: model.model, cost: model.costUsd * fraction }));
    });
    const intervalCost = overlapping.flat().reduce((sum, model) => sum + model.cost, 0);
    if (intervalCost <= 0) {
      unattributed += intervalDrop;
      continue;
    }
    overlapping.forEach((binModels, binIndex) => {
      for (const model of binModels) {
        const allocation = allocations[binIndex]!;
        allocation.set(
          model.model,
          (allocation.get(model.model) ?? 0) + (intervalDrop * model.cost) / intervalCost,
        );
      }
    });
  }
  const cumulative = new Map(models.map((model) => [model.model, 0]));
  const points = [{ at: start, costs: new Map(cumulative) }];
  allocations.forEach((allocation, binIndex) => {
    for (const [model, value] of allocation) {
      cumulative.set(model, (cumulative.get(model) ?? 0) + value);
    }
    points.push({
      at: Date.parse(ordered[binIndex]!.interval.untilTime),
      costs: new Map(cumulative),
    });
  });
  return { rows: rows(cumulative), drop, totalCost, unattributed, points };
}

export function UsageModelTracker({
  period,
  samples,
  models,
  activity,
  scope,
}: {
  readonly period: QuotaPeriod;
  readonly samples: readonly UsageQuotaSample[];
  readonly models: Models | null;
  readonly activity: readonly ChartActivity[];
  readonly scope: string;
}) {
  const id = useId();
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const data = useMemo(
    () => (models ? modelTrackerData(period, samples, models, activity) : null),
    [period, samples, models, activity],
  );
  const readings = useMemo(
    () =>
      samples.filter(
        (sample) =>
          sample.observedAt >= period.first.observedAt &&
          sample.observedAt <= period.last.observedAt,
      ),
    [samples, period],
  );
  const points = data?.points;
  const index = points ? Math.min(selectedIndex ?? points.length - 1, points.length - 1) : 0;
  const selected = points?.[index];
  const start = Date.parse(period.first.observedAt);
  const end = Date.parse(period.last.observedAt);
  const x = (at: number) => ((at - start) / Math.max(end - start, 1)) * WIDTH;
  const y = (value: number) => HEIGHT - 8 - (value / Math.max(data?.drop ?? 0, 1)) * (HEIGHT - 20);
  const percentage = (value: number) => `${value.toFixed(1)} pts`;

  return (
    <section
      id="model-impact"
      aria-labelledby={`${id}-title`}
      className="rounded-xl border border-border bg-card/20 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-2">
        <div>
          <h2 id={`${id}-title`} className="text-sm font-medium">
            Model impact
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {shortTime(period.first.observedAt)} to {shortTime(period.last.observedAt)} · {scope}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xl tabular-nums">{data ? `${data.drop.toFixed(1)} pts` : "—"}</p>
          <p className="text-xs text-muted-foreground">quota used while monitored</p>
        </div>
      </div>
      <p className="mt-3 max-w-3xl text-xs leading-relaxed text-muted-foreground">
        Model shares are estimates: each change between saved readings is divided by the models'
        API-equivalent costs in that stretch of time. Codex reports one pooled quota, not a separate
        Astra or Sol charge. Tokens and API costs below come from recorded usage. Selected computers
        should belong to the same Codex account; T3 cannot verify that identity.
      </p>

      {data && data.rows.length > 0 ? (
        <>
          <div
            className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3"
            aria-label="Model quota-equivalent estimates"
          >
            {data.rows.map((row, rowIndex) => (
              <div
                key={row.model}
                className="min-w-0 rounded-md border border-border/70 bg-background/40 px-3 py-2.5"
              >
                <div className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: COLORS[rowIndex % COLORS.length] }}
                  />
                  <Tooltip>
                    <TooltipTrigger render={<span className="truncate" tabIndex={0} />}>
                      {modelDisplayName(row.model, undefined)}
                    </TooltipTrigger>
                    <TooltipPopup>{row.model}</TooltipPopup>
                  </Tooltip>
                  <span className="ms-auto shrink-0 tabular-nums">
                    {row.estimatedPoints === null ? "—" : `≈ ${percentage(row.estimatedPoints)}`}
                  </span>
                </div>
                <p className="mt-1 ps-4 text-[11px] text-muted-foreground tabular-nums">
                  {formatTokens(tokenCount(row.totals))} tokens · {formatUsd(row.costUsd)} API
                  estimate · {(row.share * 100).toFixed(0)}% of priced activity
                </p>
              </div>
            ))}
          </div>

          {data.unattributed !== null && data.unattributed > 0 ? (
            <p className="mt-3 text-xs text-muted-foreground" role="status">
              {percentage(data.unattributed)} of the observed drop had no priced model activity
              between those readings and remains unattributed.
            </p>
          ) : null}

          {points && data.drop > 0 ? (
            <div className="mt-5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="w-4 border-t border-dashed border-foreground" />
                  Saved quota change
                </span>
                <span>Colored lines are cumulative model estimates</span>
              </div>
              <div className="mt-3 flex min-w-0 gap-2">
                <div
                  className="flex w-10 shrink-0 flex-col justify-between pb-1 text-right text-[10px] tabular-nums text-muted-foreground"
                  aria-hidden
                >
                  <span>{Math.ceil(data.drop)} pts</span>
                  <span>0</span>
                </div>
                <svg
                  viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                  preserveAspectRatio="none"
                  className="h-48 min-w-0 flex-1"
                  role="img"
                  aria-label="Observed quota change and estimated cumulative use by model"
                >
                  {[0, 0.5, 1].map((fraction) => (
                    <line
                      key={fraction}
                      x1="0"
                      x2={WIDTH}
                      y1={y(data.drop * fraction)}
                      y2={y(data.drop * fraction)}
                      stroke="currentColor"
                      className="text-border"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  <path
                    d={readings
                      .map(
                        (reading, readingIndex) =>
                          `${readingIndex ? "L" : "M"}${x(Date.parse(reading.observedAt))},${y(Math.max(0, period.first.remainingPercent - reading.remainingPercent))}`,
                      )
                      .join(" ")}
                    fill="none"
                    stroke="currentColor"
                    className="text-foreground/70"
                    strokeWidth="1.5"
                    strokeDasharray="4 4"
                    vectorEffect="non-scaling-stroke"
                  />
                  {data.rows.map((row, rowIndex) => (
                    <path
                      key={row.model}
                      d={points
                        .map(
                          (point, pointIndex) =>
                            `${pointIndex ? "L" : "M"}${x(point.at)},${y(point.costs.get(row.model) ?? 0)}`,
                        )
                        .join(" ")}
                      fill="none"
                      stroke={COLORS[rowIndex % COLORS.length]}
                      strokeWidth="2.5"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  {selected ? (
                    <line
                      x1={x(selected.at)}
                      x2={x(selected.at)}
                      y1="0"
                      y2={HEIGHT}
                      stroke="currentColor"
                      className="text-muted-foreground/60"
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}
                </svg>
              </div>
              <div className="ms-12 mt-1 flex justify-between gap-3 text-[11px] text-muted-foreground">
                <span>{shortTime(period.first.observedAt)}</span>
                <span>{shortTime(period.last.observedAt)}</span>
              </div>
              <label className="mt-3 block text-xs text-muted-foreground">
                Inspect time · {selected ? shortTime(new Date(selected.at).toISOString()) : ""}
                <input
                  className="mt-1 block min-h-11 w-full accent-foreground"
                  type="range"
                  min="0"
                  max={points.length - 1}
                  value={index}
                  onChange={(event) => setSelectedIndex(Number(event.currentTarget.value))}
                  aria-valuetext={
                    selected ? shortTime(new Date(selected.at).toISOString()) : undefined
                  }
                />
              </label>
              {selected ? (
                <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
                  {data.rows
                    .map(
                      (row) => `${row.model} ≈ ${percentage(selected.costs.get(row.model) ?? 0)}`,
                    )
                    .join(" · ")}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-4 text-xs text-muted-foreground" role="status">
              {data.drop === 0
                ? "No quota change between saved readings. Recorded model activity is still shown above."
                : "Timed model curve is waiting for complete, matching transcript coverage. The model totals above remain available."}
            </p>
          )}
        </>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          Model records for this monitored interval are not complete yet. No quota share is
          inferred.
        </p>
      )}
    </section>
  );
}
