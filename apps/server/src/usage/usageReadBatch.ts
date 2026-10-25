import type { UsageSummary, UsageSummaryInput } from "@t3tools/contracts";

/** Only day/model queries can be projected without losing attribution. */
export function usageReadBatchKey(input: UsageSummaryInput): string {
  if (input.includeRepeatedInput || input.resolution === "hour") return JSON.stringify(input);
  return JSON.stringify({
    timeZone: input.timeZone,
    resolution: input.resolution ?? "day",
    quotaProvider: input.quotaProvider ?? "codex",
    clientContractVersion: input.clientContractVersion ?? 5,
    sessionIds: input.sessionIds,
    runIds: input.runIds,
    turnIds: input.turnIds,
    groupBy: input.groupBy ?? "model",
    includeQuotaHistory: false,
    awaitRefresh: input.awaitRefresh,
  });
}

export function mergeUsageReads(inputs: readonly UsageSummaryInput[]): UsageSummaryInput {
  const first = inputs[0]!;
  const intervals = new Map(
    inputs.flatMap((input) =>
      (input.quotaIntervals ?? []).map((interval) => [JSON.stringify(interval), interval] as const),
    ),
  );
  return {
    ...first,
    sinceDay: inputs.reduce(
      (day, input) => (input.sinceDay < day ? input.sinceDay : day),
      first.sinceDay,
    ),
    untilDay: inputs.reduce(
      (day, input) => (input.untilDay > day ? input.untilDay : day),
      first.untilDay,
    ),
    includeQuotaHistory: inputs.some((input) => input.includeQuotaHistory),
    refresh: inputs.some((input) => input.refresh),
    providers: inputs.some(
      (input) => input.providers === undefined && input.quotaIntervals === undefined,
    )
      ? undefined
      : [
          ...new Set(
            inputs.flatMap((input) => input.providers ?? [input.quotaProvider ?? "codex"]),
          ),
        ],
    quotaIntervals:
      intervals.size > 0
        ? [...intervals.values()]
        : inputs.some((input) => input.quotaIntervals !== undefined)
          ? []
          : undefined,
  };
}

export function projectUsageRead(summary: UsageSummary, input: UsageSummaryInput): UsageSummary {
  const selected = (provider: UsageSummary["sources"][number]["fingerprint"]["provider"]) =>
    (input.providers === undefined || input.providers.includes(provider)) &&
    (input.quotaIntervals === undefined || provider === (input.quotaProvider ?? "codex"));
  const ids = new Set(input.quotaIntervals?.map((interval) => interval.id));
  return {
    ...summary,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    buckets: summary.buckets.filter(
      (bucket) =>
        selected(bucket.provider) && bucket.day >= input.sinceDay && bucket.day <= input.untilDay,
    ),
    sources: summary.sources.filter((source) => selected(source.fingerprint.provider)),
    quotaCosts:
      input.quotaIntervals === undefined
        ? undefined
        : summary.quotaCosts?.filter((row) => ids.has(row.intervalId)),
    quotaCostSnapshots: summary.quotaCostSnapshots?.filter(
      (row) => input.quotaIntervals === undefined || ids.has(row.intervalId),
    ),
  };
}
