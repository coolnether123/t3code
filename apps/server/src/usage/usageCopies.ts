import type { UsageRecord } from "@t3tools/provider-core/server/usage";

export function mergeUsageCopies<
  T extends Pick<UsageRecord, "totals" | "reportedCostUsd" | "cacheCreation1hTokens">,
>(held: T, copy: T): T {
  const a = held.totals;
  const b = copy.totals;
  const reportedCostUsd =
    held.reportedCostUsd === null || copy.reportedCostUsd === null
      ? (held.reportedCostUsd ?? copy.reportedCostUsd)
      : Math.max(held.reportedCostUsd, copy.reportedCostUsd);
  if (
    b.uncachedInputTokens <= a.uncachedInputTokens &&
    b.cachedInputTokens <= a.cachedInputTokens &&
    b.cacheCreationTokens <= a.cacheCreationTokens &&
    b.outputTokens <= a.outputTokens &&
    b.reasoningTokens <= a.reasoningTokens &&
    (copy.cacheCreation1hTokens ?? 0) <= (held.cacheCreation1hTokens ?? 0) &&
    reportedCostUsd === held.reportedCostUsd
  ) {
    return held;
  }
  const cacheCreation1hTokens = Math.max(
    held.cacheCreation1hTokens ?? 0,
    copy.cacheCreation1hTokens ?? 0,
  );
  return {
    ...held,
    ...(cacheCreation1hTokens > 0 ? { cacheCreation1hTokens } : {}),
    totals: {
      uncachedInputTokens: Math.max(a.uncachedInputTokens, b.uncachedInputTokens),
      cachedInputTokens: Math.max(a.cachedInputTokens, b.cachedInputTokens),
      cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
      outputTokens: Math.max(a.outputTokens, b.outputTokens),
      reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens),
    },
    reportedCostUsd,
  };
}
