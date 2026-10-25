import type { UsageSummaryInput } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import {
  resetHistoryPlan,
  subscriptionPayments,
  usageMonthIntervals,
} from "@t3tools/shared/usageResetReport";
import { quotaCostWindow } from "@t3tools/shared/usageQuota";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import type { PublicResetHistory } from "@t3tools/client-runtime/publicResetHistory";

const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function UsageValueHistory({
  history,
  publicHistory,
  selectedIds,
  subscription,
  historyInput,
}: {
  readonly history: readonly EnvironmentUsageStatus[];
  readonly publicHistory: PublicResetHistory;
  readonly selectedIds: readonly string[] | null;
  readonly subscription: {
    readonly plan: string;
    readonly monthlyUsd: number;
    readonly startDate: string;
  };
  readonly historyInput: UsageSummaryInput;
}) {
  const selected = (environment: EnvironmentUsageStatus) =>
    selectedIds === null || selectedIds.includes(environment.environmentId);
  const selectedHistory = history.filter(selected);
  const ready =
    publicHistory.status === "ready" &&
    selectedHistory.length > 0 &&
    selectedHistory.every((entry) => entry.summary !== null);
  const initial = selectedHistory.flatMap((entry) => entry.summary?.quotaCostSnapshots ?? []);
  const now =
    history.find((entry) => entry.summary !== null)?.summary?.readAt ??
    `${subscription.startDate}T00:00:00.000Z`;
  const announcements = publicHistory.announcements
    .filter((row) => row.resetType === "regular")
    .map((row) => row.announcedAt);
  const sinceTime = `${subscription.startDate}T00:00:00.000Z`;
  const samples = selectedHistory[0]?.summary?.quotaHistory?.samples ?? [];
  const plan = resetHistoryPlan(initial, sinceTime, now, announcements, samples);
  const missing = plan.flatMap((window) => window.missing).slice(-64);
  const costs = useUsage(ready ? (quotaCostWindow(missing) ?? historyInput) : historyInput);
  const months = usageMonthIntervals(subscription.startDate, now);
  const monthly = useUsage(
    ready ? (quotaCostWindow(months.slice(-64)) ?? historyInput) : historyInput,
  );
  const saved = [
    ...initial,
    ...costs.environments
      .filter(selected)
      .flatMap((entry) => entry.summary?.quotaCostSnapshots ?? []),
  ];
  const windows = resetHistoryPlan(saved, sinceTime, now, announcements, samples);
  const paid = subscriptionPayments(subscription.startDate, subscription.monthlyUsd, now);
  const totalPaid = paid.reduce((sum, payment) => sum + payment.paidUsd, 0);
  const totalValue = windows.reduce((sum, window) => sum + window.costUsd, 0);
  const ratio = (value: number, payment: number) =>
    payment > 0 ? `${(value / payment).toFixed(1)}×` : "";
  const monthlyRows = monthly.environments
    .filter(selected)
    .flatMap((entry) => entry.summary?.quotaCosts ?? []);
  const monthValue = (id: string) => {
    const rows = monthlyRows.filter((row) => row.intervalId === id);
    return rows.length > 0 && rows.every((row) => row.complete && row.unpricedRecords === 0)
      ? rows.reduce((sum, row) => sum + row.costUsd, 0)
      : null;
  };
  if (!ready)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {publicHistory.status === "unavailable" ? "Reset history is unavailable" : "Still counting"}
      </p>
    );
  return (
    <div className="space-y-3">
      <details>
        <summary className="cursor-pointer text-sm tabular-nums">
          {formatUsd(totalPaid)} paid · {formatUsd(totalValue)} estimated API value ·{" "}
          {ratio(totalValue, totalPaid)}
        </summary>
        <dl className="mt-3 space-y-2 text-xs tabular-nums">
          {months.toReversed().map((month) => {
            const value = monthValue(month.id);
            const payment = paid.find((entry) => entry.month === month.id.slice(6))?.paidUsd ?? 0;
            return (
              <div key={month.id} className="flex flex-wrap justify-between gap-2">
                <dt>{month.id.slice(6)}</dt>
                <dd>
                  {formatUsd(payment)} paid ·{" "}
                  {value === null
                    ? "Still counting"
                    : `${formatUsd(value)} value · ${ratio(value, payment)}`}
                </dd>
              </div>
            );
          })}
        </dl>
      </details>
      <ol className="divide-y divide-border">
        {windows.toReversed().map((window) => {
          const models = new Map<string, number>();
          for (const row of window.sources)
            for (const model of row.models ?? [])
              models.set(model.model, (models.get(model.model) ?? 0) + model.costUsd);
          const complete = window.missing.length === 0;
          return (
            <li key={window.sinceTime} className="py-3">
              <details>
                <summary className="flex cursor-pointer flex-wrap justify-between gap-3 text-sm">
                  <span>
                    {dateTime(window.sinceTime)}
                    <span className="block pt-1 text-xs text-muted-foreground">
                      to {window.open ? "now" : dateTime(window.untilTime)}
                    </span>
                  </span>
                  <span className="text-right tabular-nums">
                    {complete || window.costUsd > 0 ? formatUsd(window.costUsd) : "Still counting"}
                    <span className="block pt-1 text-xs text-muted-foreground">
                      {window.remainingPercent === null
                        ? "Estimated from transcripts"
                        : `${100 - window.remainingPercent}% used${window.open ? "" : window.remainingPercent === 0 ? " · limit reached 0%" : ` · reset at ${window.remainingPercent}% left`}`}
                    </span>
                  </span>
                </summary>
                {!complete ? (
                  <p role="status" className="mt-2 text-xs text-muted-foreground">
                    Still counting
                  </p>
                ) : null}
                <dl className="mt-3 space-y-2 text-xs">
                  {[...models]
                    .sort((a, b) => b[1] - a[1])
                    .map(([model, dollars]) => (
                      <div key={model} className="flex justify-between gap-3">
                        <dt className="break-all">{model}</dt>
                        <dd className="tabular-nums">{formatUsd(dollars)}</dd>
                      </div>
                    ))}
                </dl>
              </details>
            </li>
          );
        })}
      </ol>
      <div className="flex justify-between border-t border-border pt-3 text-sm tabular-nums">
        <span>Grand total</span>
        <span>{formatUsd(totalValue)}</span>
      </div>
    </div>
  );
}
