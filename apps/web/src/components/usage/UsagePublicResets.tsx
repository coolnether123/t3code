import type { PublicResetHistory } from "@t3tools/client-runtime/publicResetHistory";
import type { publicResetCostEstimates } from "@t3tools/client-runtime/publicResetHistory";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

type Estimate = ReturnType<typeof publicResetCostEstimates>[number];

const inputTokens = (totals: Estimate["models"][number]["totals"]) =>
  totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens;

/**
 * Codex transcript usage between publicly announced resets, priced at API rates.
 * Amounts appear only once the matching cost read has finished, so a loading
 * page never claims that no transcripts exist.
 */
export function UsagePublicResets({
  history,
  estimates,
  costsReady,
  scope,
}: {
  readonly history: PublicResetHistory;
  readonly estimates: ReturnType<typeof publicResetCostEstimates>;
  readonly costsReady: boolean;
  readonly scope: string;
}) {
  const banked = history.announcements.filter((row) => row.resetType === "banked").length;
  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
        Regular public reset announcements from{" "}
        <a
          className="underline underline-offset-4 hover:text-foreground"
          href="https://codex-resets.com/"
          target="_blank"
          rel="noreferrer"
        >
          Codex Resets
        </a>{" "}
        split recorded Codex usage from {scope} into periods priced at current API rates. The source
        never receives your usage or account data, and announcement time can differ from when a
        reset reached your account.
        {banked > 0
          ? ` ${banked} banked reset grant${banked === 1 ? " is" : "s are"} listed but do not split periods, because redemption is account-specific.`
          : ""}
      </p>
      {history.status === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reading public reset history…
        </p>
      ) : history.status === "unavailable" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Codex Resets is unavailable right now. Your own saved readings are unaffected.
        </p>
      ) : estimates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The public history does not contain two regular resets yet.
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {estimates.toReversed().map((row) => (
            <li key={row.interval.id} className="flex flex-wrap justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm">
                  {row.endedBy.sourceUrl ? (
                    <a
                      className="hover:underline"
                      href={row.endedBy.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Reset announced {dateTime(row.endedBy.announcedAt)}
                    </a>
                  ) : (
                    <>Reset observed {dateTime(row.endedBy.announcedAt)}</>
                  )}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  From {dateTime(row.startedBy.announcedAt)}
                  {row.endedBy.sourceType === "observed" ? " · observed report" : ""}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm tabular-nums">
                  {!costsReady
                    ? "Calculating…"
                    : row.costUsd === null
                      ? "Estimate unavailable"
                      : formatUsd(row.costUsd)}
                </p>
                {costsReady ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.records > 0 ? `${row.records.toLocaleString()} usage records` : row.reason}
                  </p>
                ) : null}
              </div>
              {costsReady && row.models.length > 0 ? (
                <details className="w-full rounded-md border border-border/70 px-3 py-1.5">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Models ·{" "}
                    {formatTokens(row.models.reduce((t, m) => t + inputTokens(m.totals), 0))} input
                    · {formatTokens(row.models.reduce((t, m) => t + m.totals.outputTokens, 0))}{" "}
                    output
                  </summary>
                  <table className="mt-2 w-full text-left text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-3 font-normal">Model</th>
                        <th className="px-3 py-1 text-right font-normal">Input</th>
                        <th className="px-3 py-1 text-right font-normal">Output</th>
                        <th className="py-1 pl-3 text-right font-normal">API value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.models.map((model) => (
                        <tr key={model.model} className="border-t border-border/70">
                          <td className="py-1.5 pr-3">{model.model}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {formatTokens(inputTokens(model.totals))}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {formatTokens(model.totals.outputTokens)}
                          </td>
                          <td className="py-1.5 pl-3 text-right tabular-nums">
                            {model.unpricedRecords > 0 ? "Unpriced" : formatUsd(model.costUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ) : null}
              {costsReady && row.reason && row.records > 0 ? (
                <p className="w-full text-xs text-muted-foreground">{row.reason}</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
