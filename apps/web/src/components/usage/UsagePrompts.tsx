import type { EnvironmentId, UsageReportInput, UsageReportPrompts } from "@t3tools/contracts";
import { formatCount } from "@t3tools/shared/usageFormat";
import { useEffect, useRef } from "react";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { Button } from "../ui/button";

export function PromptUsageContent({ report }: { report: UsageReportPrompts }) {
  if (report.coverage.status === "missing") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Prompt history is unavailable.
      </p>
    );
  }
  return (
    <>
      {report.coverage.status === "partial" ? (
        <p role="status" className="text-xs text-muted-foreground">
          Partial history. These counts cover only the messages examined, not the entire period.
        </p>
      ) : null}
      <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
        {[
          ["Prompts", formatCount(report.totals.prompts)],
          ["Words", formatCount(report.totals.words)],
          [
            "Words per prompt",
            report.totals.averageWordsPerPrompt === null
              ? "Unavailable"
              : report.totals.averageWordsPerPrompt.toFixed(1),
          ],
          ["Chats", formatCount(report.totals.threads)],
          ["Active days", formatCount(report.totals.activeDays)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {report.totals.prompts === 0 ? (
        <p className="text-sm text-muted-foreground">No stored user prompts in this period.</p>
      ) : (
        <div className="grid min-w-0 gap-5 md:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs font-medium">Frequent words</h4>
            <p className="mb-2 text-xs text-muted-foreground">
              Common English words and word runs containing digits omitted.
            </p>
            {report.words.length === 0 ? (
              <p className="text-xs text-muted-foreground">No words remain after filtering.</p>
            ) : (
              <ol className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                {report.words.map(({ word, count }) => (
                  <li key={word} className="flex min-w-0 justify-between gap-2">
                    <span className="break-all">{word}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatCount(count)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {report.wordsTruncated ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing {report.words.length} of {formatCount(report.countedDistinctWords)} counted
                words.
              </p>
            ) : null}
          </div>
          <div className="max-h-52 overflow-auto">
            <table className="w-full text-left text-xs">
              <caption className="mb-2 text-left font-medium">Daily prompt usage</caption>
              <thead>
                <tr className="text-muted-foreground">
                  <th scope="col">Day</th>
                  <th scope="col" className="text-right">
                    Prompts
                  </th>
                  <th scope="col" className="text-right">
                    Words
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.daily.toReversed().map((day) => (
                  <tr key={day.day}>
                    <th scope="row" className="py-1 font-normal">
                      {day.day}
                    </th>
                    <td className="text-right tabular-nums">{formatCount(day.prompts)}</td>
                    <td className="text-right tabular-nums">{formatCount(day.words)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function EnvironmentPrompts({
  environment,
  input,
  refreshRevision,
}: {
  environment: EnvironmentUsageStatus;
  input: UsageReportInput;
  refreshRevision: number;
}) {
  const query = useEnvironmentQuery(
    environment.connection.phase === "connected"
      ? serverEnvironment.usageReport({ environmentId: environment.environmentId, input })
      : null,
  );
  const { refresh } = query;
  const lastRefreshRevision = useRef(refreshRevision);
  useEffect(() => {
    if (lastRefreshRevision.current === refreshRevision) return;
    lastRefreshRevision.current = refreshRevision;
    if (environment.connection.phase === "connected") refresh();
  }, [refreshRevision, environment.connection.phase, refresh]);
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{environment.label}</h3>
        <Button
          size="xs"
          variant="ghost"
          disabled={query.isPending || environment.connection.phase !== "connected"}
          onClick={() => refresh()}
          aria-label={`Refresh prompt usage for ${environment.label}`}
        >
          Refresh
        </Button>
      </div>
      {environment.connection.phase !== "connected" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Connect this environment to read prompt history.
        </p>
      ) : query.data?.mode === "prompts" ? (
        <PromptUsageContent report={query.data} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {query.isPending
            ? "Reading prompt history…"
            : "Prompt history is unavailable on this server."}
        </p>
      )}
    </div>
  );
}

export function UsagePrompts({
  environments,
  selectedEnvironmentIds,
  window,
  refreshRevision,
}: {
  environments: readonly EnvironmentUsageStatus[];
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  window: Omit<UsageReportInput, "mode">;
  refreshRevision: number;
}) {
  const input: UsageReportInput = {
    mode: "prompts",
    sinceDay: window.sinceDay,
    untilDay: window.untilDay,
    timeZone: window.timeZone,
    ...(window.sinceTime === undefined
      ? {}
      : { sinceTime: window.sinceTime, untilTime: window.untilTime }),
    limit: 20,
  };
  const selected = environments.filter(
    (entry) => selectedEnvironmentIds === null || selectedEnvironmentIds.has(entry.environmentId),
  );
  return (
    <section aria-label="Prompt and word usage" className="mb-6 space-y-4">
      <div>
        <h2 className="text-base font-medium">Prompts &amp; words</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Stored T3 user messages only, including imported and archived chats. Attachment contents
          and agent replies are excluded. Words are not tokens. Copies in separate chats count
          separately; environments are not added together.
        </p>
      </div>
      {selected.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          No environments selected.
        </p>
      ) : (
        selected.map((environment) => (
          <EnvironmentPrompts
            key={environment.environmentId}
            environment={environment}
            input={input}
            refreshRevision={refreshRevision}
          />
        ))
      )}
    </section>
  );
}
