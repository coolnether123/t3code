import { useMemo, useState } from "react";
import type { UsageQuotaSample } from "@t3tools/contracts";
import { quotaCostWindow, type QuotaPeriod } from "@t3tools/shared/usageQuota";
import { formatTokens, formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { quotaDuration } from "@t3tools/shared/usageQuotaForecast";
import { useUsage } from "../../state/usage";
import { monitoredModels } from "./usageTokenBudget";
import { compareQuotaCycles, cycleCostStats } from "./cycleComparisonMath";

const cycleDate = (period: QuotaPeriod) =>
  new Date(period.first.observedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const pointDifference = (difference: number) =>
  Math.abs(difference) < 0.05
    ? "Same quota use"
    : `${Math.abs(difference).toFixed(1)} points ${difference > 0 ? "more" : "less"} quota used`;

export function UsageCycleComparison({
  period,
  periods,
  samples,
  selectedIds,
}: {
  readonly period: QuotaPeriod;
  readonly periods: readonly QuotaPeriod[];
  readonly samples: readonly UsageQuotaSample[];
  readonly selectedIds: readonly string[] | null;
}) {
  const [baselineId, setBaselineId] = useState("");
  const [open, setOpen] = useState(false);
  const older = periods.filter((candidate) => candidate.first.observedAt < period.first.observedAt);
  const baseline = older.find((candidate) => candidate.id === baselineId) ?? older.at(-1);
  const comparison = baseline ? compareQuotaCycles(period, baseline, samples) : null;
  if (!baseline)
    return (
      <section
        id="cycle-comparison"
        className="border-t border-border py-3"
        aria-label="Compare cycles"
      >
        <h2 className="text-sm font-medium">Compare cycles</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          This is the oldest saved cycle. Choose a newer cycle above to compare it with this one.
        </p>
      </section>
    );
  return (
    <section
      id="cycle-comparison"
      aria-label="Compare cycles"
      className="min-w-0 rounded-xl border border-border bg-card/20 px-3 sm:px-4"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="cycle-comparison-detail"
        onClick={() => setOpen(!open)}
        className="flex min-h-14 w-full items-center justify-between gap-3 py-2 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium">Compare cycles</span>
          <span className="block text-xs text-muted-foreground">
            {comparison
              ? `${pointDifference(comparison.difference)} vs ${cycleDate(baseline)}, first ${quotaDuration(comparison.duration)} recorded`
              : "Choose an older cycle to compare recorded usage."}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{open ? "Hide" : "Explore"}</span>
      </button>
      {open ? (
        <div id="cycle-comparison-detail" className="space-y-3 border-t border-border py-3">
          <label className="flex flex-wrap items-center gap-2 text-xs">
            Compare selected cycle with
            <select
              aria-label="Comparison cycle"
              value={baseline.id}
              onChange={(event) => setBaselineId(event.target.value)}
              className="min-h-11 min-w-0 max-w-full flex-1 rounded-md border border-border bg-background px-2 text-base sm:flex-none sm:text-sm"
            >
              {older.toReversed().map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {cycleDate(candidate)} · {candidate.usedPercentagePoints}% observed use
                </option>
              ))}
            </select>
          </label>
          {comparison ? (
            <>
              <p className="text-xs text-muted-foreground">
                First {quotaDuration(comparison.duration)} from each cycle's first saved reading.
                The shorter recorded cycle sets the comparison window.
              </p>
              <ComparisonPlot comparison={comparison} />
              <div className="grid grid-cols-2 gap-3 text-xs">
                <p>
                  <span className="text-muted-foreground">Selected · {cycleDate(period)}</span>
                  <br />
                  <span className="text-base tabular-nums">
                    {comparison.selected.used.toFixed(1)} points used
                  </span>
                </p>
                <p>
                  <span className="text-muted-foreground">Earlier · {cycleDate(baseline)}</span>
                  <br />
                  <span className="text-base tabular-nums">
                    {comparison.baseline.used.toFixed(1)} points used
                  </span>
                </p>
              </div>
              <ComparisonCosts
                key={`${period.id}:${baseline.id}`}
                comparison={comparison}
                selectedIds={selectedIds}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Quota lines join saved readings; a boundary between readings is interpolated.
                Monitoring may begin after a reset, and gaps do not reveal when usage occurred. API
                values cover recorded Codex transcripts on the same selected computers, including
                idle time.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              This pair needs at least two readings in each cycle. Choose another older cycle or
              wait for the next reading.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

type Comparison = NonNullable<ReturnType<typeof compareQuotaCycles>>;

function ComparisonPlot({ comparison }: { readonly comparison: Comparison }) {
  const max = Math.max(
    1,
    Math.ceil(Math.max(comparison.selected.used, comparison.baseline.used) / 5) * 5,
  );
  const path = (points: Comparison["selected"]["points"]) =>
    points
      .map(
        (point, index) =>
          `${index ? "L" : "M"}${40 + (point.elapsed / comparison.duration) * 640},${115 - (point.used / max) * 100}`,
      )
      .join(" ");
  return (
    <figure aria-label="Quota used over equal recorded time">
      <div className="flex flex-wrap gap-4 text-xs">
        <span className="text-sky-500">━ Selected cycle</span>
        <span className="text-muted-foreground">┄ Earlier cycle</span>
      </div>
      <svg
        role="img"
        aria-label={`Selected cycle used ${comparison.selected.used.toFixed(1)} quota points; earlier cycle used ${comparison.baseline.used.toFixed(1)} over ${quotaDuration(comparison.duration)}`}
        viewBox="0 0 720 145"
        className="h-36 w-full overflow-visible"
      >
        {[0, max / 2, max].map((value) => (
          <g key={value}>
            <line
              x1="40"
              x2="680"
              y1={115 - (value / max) * 100}
              y2={115 - (value / max) * 100}
              className="stroke-border"
              strokeDasharray="2 4"
            />
            <text
              x="32"
              y={119 - (value / max) * 100}
              textAnchor="end"
              className="fill-muted-foreground text-[12px]"
            >
              {value}
            </text>
          </g>
        ))}
        <path
          d={path(comparison.baseline.points)}
          fill="none"
          className="stroke-muted-foreground"
          strokeWidth="2"
          strokeDasharray="5 4"
        />
        <path
          d={path(comparison.selected.points)}
          fill="none"
          className="stroke-sky-500"
          strokeWidth="2.5"
        />
        <text x="40" y="140" className="fill-muted-foreground text-[12px]">
          First reading
        </text>
        <text x="680" y="140" textAnchor="end" className="fill-muted-foreground text-[12px]">
          {quotaDuration(comparison.duration)} recorded
        </text>
      </svg>
    </figure>
  );
}

function ComparisonCosts({
  comparison,
  selectedIds,
}: {
  readonly comparison: Comparison;
  readonly selectedIds: readonly string[] | null;
}) {
  const input = useMemo(
    () =>
      quotaCostWindow([comparison.baseline.interval, comparison.selected.interval]) ??
      makeWindow(1),
    [comparison],
  );
  const usage = useUsage(input);
  const environments = usage.environments.filter(
    (environment) => selectedIds === null || selectedIds.includes(environment.environmentId),
  );
  const allPresent =
    selectedIds === null ||
    selectedIds.every((id) => environments.some((environment) => environment.environmentId === id));
  const currentModels = allPresent
    ? monitoredModels(comparison.selected.interval, environments)
    : null;
  const priorModels = allPresent
    ? monitoredModels(comparison.baseline.interval, environments)
    : null;
  const current = cycleCostStats(currentModels, comparison.hours);
  const prior = cycleCostStats(priorModels, comparison.hours);
  if (!current || !prior)
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
      >
        <span>
          {usage.isPending || environments.some((environment) => environment.isPending)
            ? "Reading transcript costs for both windows…"
            : "Complete priced transcripts are unavailable for one or both windows. Quota comparison remains available."}
        </span>
        <button
          type="button"
          onClick={() => void usage.refresh()}
          disabled={usage.isPending}
          className="min-h-11 rounded-md border border-border px-3 disabled:opacity-50"
        >
          Retry costs
        </button>
      </div>
    );
  const difference = current.perHour - prior.perHour;
  const modelChanges = [
    ...new Set([
      ...currentModels!.map((model) => model.model),
      ...priorModels!.map((model) => model.model),
    ]),
  ]
    .map((model) => {
      const selected =
        (currentModels!.find((entry) => entry.model === model)?.costUsd ?? 0) / comparison.hours;
      const earlier =
        (priorModels!.find((entry) => entry.model === model)?.costUsd ?? 0) / comparison.hours;
      return { model, selected, earlier, change: selected - earlier };
    })
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  const biggest = modelChanges[0];
  const cacheChange =
    current.cachePercent !== null && prior.cachePercent !== null
      ? current.cachePercent - prior.cachePercent
      : null;
  const rows = [
    ["API value / hour", formatUsd(current.perHour), formatUsd(prior.perHour)],
    ["API value in window", formatUsd(current.cost), formatUsd(prior.cost)],
    [
      "Input cache hit rate",
      current.cachePercent === null ? "No input" : `${current.cachePercent.toFixed(1)}%`,
      prior.cachePercent === null ? "No input" : `${prior.cachePercent.toFixed(1)}%`,
    ],
    [
      "Output tokens / hour",
      formatTokens(current.outputPerHour),
      formatTokens(prior.outputPerHour),
    ],
  ];
  return (
    <div className="space-y-3">
      <ul className="space-y-1 text-xs leading-relaxed" aria-label="Cycle insights">
        <li>
          {Math.abs(difference) < 0.005
            ? "API spending pace is unchanged."
            : `${formatUsd(Math.abs(difference))}/h ${difference > 0 ? "higher" : "lower"} API spending${prior.perHour > 0 ? `, ${Math.abs((difference / prior.perHour) * 100).toFixed(0)}% ${difference > 0 ? "more" : "less"} than the earlier window` : "; the earlier window had no recorded spend"}.`}
        </li>
        {biggest && Math.abs(biggest.change) >= 0.005 ? (
          <li>
            {biggest.model} accounts for the largest model change:{" "}
            {formatUsd(Math.abs(biggest.change))}/h {biggest.change > 0 ? "more" : "less"}.
          </li>
        ) : null}
        {cacheChange !== null && Math.abs(cacheChange) >= 0.1 ? (
          <li>
            Input cache hit rate is {Math.abs(cacheChange).toFixed(1)} points{" "}
            {cacheChange > 0 ? "higher" : "lower"}. This reflects the recorded workload, not a
            measured productivity change.
          </li>
        ) : null}
      </ul>
      <table className="w-full table-fixed text-xs" aria-label="Cycle cost comparison">
        <thead>
          <tr className="text-muted-foreground">
            <th className="w-[46%] py-2 text-left font-normal">Same recorded duration</th>
            <th className="text-right font-normal">Selected</th>
            <th className="text-right font-normal">Earlier</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, selected, earlier]) => (
            <tr key={label} className="border-t border-border">
              <th className="py-2 text-left font-normal">{label}</th>
              <td className="text-right tabular-nums">{selected}</td>
              <td className="text-right tabular-nums">{earlier}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary className="min-h-11 cursor-pointer content-center text-xs">
          Model changes · {modelChanges.length} models
        </summary>
        <table className="w-full table-fixed text-xs" aria-label="Model hourly cost comparison">
          <thead className="text-muted-foreground">
            <tr>
              <th className="w-[46%] py-2 text-left font-normal">API value / hour</th>
              <th className="text-right font-normal">Selected</th>
              <th className="text-right font-normal">Earlier</th>
            </tr>
          </thead>
          <tbody>
            {modelChanges.map((row) => (
              <tr key={row.model} className="border-t border-border">
                <th className="break-words py-2 pr-2 text-left font-normal">{row.model}</th>
                <td className="text-right tabular-nums">{formatUsd(row.selected)}</td>
                <td className="text-right tabular-nums">{formatUsd(row.earlier)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
