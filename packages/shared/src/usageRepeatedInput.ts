import type {
  UsageRepeatedInputBreakdown,
  UsageRepeatedInputConfidence,
  UsageRepeatedInputCoverageGap,
  UsageRepeatedInputItem,
  UsageRepeatedInputModelCost,
  UsageRepeatedInputPriceStatus,
  UsageRepeatedInputSummary,
  UsageRepeatedInputTokenAttribution,
  UsageSummary,
} from "@t3tools/contracts";

export interface EnvironmentRepeatedInput {
  readonly environmentId: string;
  readonly summary: UsageSummary | null;
}

const EMPTY_TOKENS: UsageRepeatedInputTokenAttribution = {
  exact: 0,
  estimated: 0,
  cached: 0,
  cacheWrite: 0,
  unknown: 0,
};

function addTokens(
  left: UsageRepeatedInputTokenAttribution,
  right: UsageRepeatedInputTokenAttribution,
): UsageRepeatedInputTokenAttribution {
  return {
    exact: left.exact + right.exact,
    estimated: left.estimated + right.estimated,
    cached: left.cached + right.cached,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    unknown: left.unknown + right.unknown,
  };
}

function mergeCost(
  leftCost: number | null,
  leftStatus: UsageRepeatedInputPriceStatus,
  rightCost: number | null,
  rightStatus: UsageRepeatedInputPriceStatus,
): { readonly cost: number | null; readonly status: UsageRepeatedInputPriceStatus } {
  const cost = leftCost === null ? rightCost : rightCost === null ? leftCost : leftCost + rightCost;
  return {
    cost,
    status:
      leftStatus === "unpriced" || rightStatus === "unpriced"
        ? "unpriced"
        : leftStatus === "providerReported" || rightStatus === "providerReported"
          ? "providerReported"
          : "estimated",
  };
}

function confidenceRank(value: UsageRepeatedInputConfidence): number {
  return value === "confirmedPayload" ? 3 : value === "likelyRead" ? 2 : 1;
}

function sourceSignature(summary: UsageSummary, environmentId: string): string {
  const fingerprints = summary.sources
    .filter((source) => source.fingerprint.provider === "codex" && source.status !== "missing")
    .map((source) => {
      const fingerprint = source.fingerprint;
      return [
        fingerprint.hostId,
        fingerprint.provider,
        fingerprint.resolvedHomePath,
        fingerprint.volumeId,
      ].join("\u0000");
    })
    .sort();
  return fingerprints.length === 0 ? `environment:${environmentId}` : fingerprints.join("\u0001");
}

function breakdownKey(value: UsageRepeatedInputBreakdown): string {
  return [
    value.sourceKind,
    value.model ?? "",
    value.project ?? "",
    value.environment ?? "",
    value.sinceDay,
    value.untilDay,
  ].join("\u0000");
}

function mergeBreakdowns(
  values: readonly UsageRepeatedInputBreakdown[],
): UsageRepeatedInputBreakdown[] {
  const merged = new Map<string, UsageRepeatedInputBreakdown>();
  for (const value of values) {
    const key = breakdownKey(value);
    const previous = merged.get(key);
    if (previous === undefined) {
      merged.set(key, value);
      continue;
    }
    const cost = mergeCost(
      previous.estimatedApiCostUsd,
      previous.priceStatus,
      value.estimatedApiCostUsd,
      value.priceStatus,
    );
    merged.set(key, {
      ...previous,
      occurrences: previous.occurrences + value.occurrences,
      sessions: previous.sessions + value.sessions,
      turns: previous.turns + value.turns,
      directTokens: addTokens(previous.directTokens, value.directTokens),
      fullSessionInputTokens: addTokens(
        previous.fullSessionInputTokens,
        value.fullSessionInputTokens,
      ),
      estimatedApiCostUsd: cost.cost,
      priceStatus: cost.status,
    });
  }
  return [...merged.values()];
}

function mergeModelCosts(
  values: readonly UsageRepeatedInputModelCost[],
): UsageRepeatedInputModelCost[] {
  const merged = new Map<string, UsageRepeatedInputModelCost>();
  for (const value of values) {
    const previous = merged.get(value.model);
    if (previous === undefined) {
      merged.set(value.model, value);
      continue;
    }
    const cost = mergeCost(
      previous.estimatedApiCostUsd,
      previous.priceStatus,
      value.estimatedApiCostUsd,
      value.priceStatus,
    );
    merged.set(value.model, {
      model: value.model,
      directTokens: addTokens(previous.directTokens, value.directTokens),
      estimatedApiCostUsd: cost.cost,
      priceStatus: cost.status,
      occurrences: previous.occurrences + value.occurrences,
    });
  }
  return [...merged.values()].sort((left, right) => left.model.localeCompare(right.model));
}

function mergeItems(values: readonly UsageRepeatedInputItem[]): UsageRepeatedInputItem[] {
  const merged = new Map<string, UsageRepeatedInputItem>();
  for (const value of values) {
    const key = `${value.sourceKind}\u0000${value.contentHash}`;
    const previous = merged.get(key);
    if (previous === undefined) {
      merged.set(key, value);
      continue;
    }
    merged.set(key, {
      ...previous,
      fileRevisionHash: value.fileRevisionHash ?? previous.fileRevisionHash,
      firstObservedAt:
        Date.parse(value.firstObservedAt) < Date.parse(previous.firstObservedAt)
          ? value.firstObservedAt
          : previous.firstObservedAt,
      lastObservedAt:
        Date.parse(value.lastObservedAt) > Date.parse(previous.lastObservedAt)
          ? value.lastObservedAt
          : previous.lastObservedAt,
      occurrences: previous.occurrences + value.occurrences,
      affectedSessions: previous.affectedSessions + value.affectedSessions,
      affectedTurns: previous.affectedTurns + value.affectedTurns,
      confidence:
        confidenceRank(value.confidence) > confidenceRank(previous.confidence)
          ? value.confidence
          : previous.confidence,
      confidenceCounts: {
        reference: previous.confidenceCounts.reference + value.confidenceCounts.reference,
        likelyRead: previous.confidenceCounts.likelyRead + value.confidenceCounts.likelyRead,
        confirmedPayload:
          previous.confidenceCounts.confirmedPayload + value.confidenceCounts.confirmedPayload,
      },
      directTokens: addTokens(previous.directTokens, value.directTokens),
      fullSessionInputTokens: addTokens(
        previous.fullSessionInputTokens,
        value.fullSessionInputTokens,
      ),
      modelCosts: mergeModelCosts([...previous.modelCosts, ...value.modelCosts]),
      breakdowns: mergeBreakdowns([...previous.breakdowns, ...value.breakdowns]),
    });
  }
  return [...merged.values()].sort((left, right) =>
    right.lastObservedAt.localeCompare(left.lastObservedAt),
  );
}

function mergeGaps(
  values: readonly UsageRepeatedInputCoverageGap[],
): UsageRepeatedInputCoverageGap[] {
  const merged = new Map<string, UsageRepeatedInputCoverageGap>();
  for (const value of values) {
    const key = `${value.reason}\u0000${value.message}`;
    const previous = merged.get(key);
    merged.set(key, { ...value, count: (previous?.count ?? 0) + value.count });
  }
  return [...merged.values()];
}

/** Merges ordinary Usage projections while counting mirrored Codex homes once. */
export function mergeRepeatedInputSummaries(
  environments: readonly EnvironmentRepeatedInput[],
): UsageRepeatedInputSummary | undefined {
  const summaries: UsageRepeatedInputSummary[] = [];
  const sourceSignatures = new Set<string>();
  for (const environment of environments) {
    if (environment.summary?.repeatedInput === undefined) continue;
    const signature = sourceSignature(environment.summary, environment.environmentId);
    if (sourceSignatures.has(signature)) continue;
    sourceSignatures.add(signature);
    summaries.push(environment.summary.repeatedInput);
  }
  if (summaries.length === 0) return undefined;

  let cost: number | null = null;
  let status: UsageRepeatedInputPriceStatus = "estimated";
  for (const summary of summaries) {
    const next = mergeCost(cost, status, summary.estimatedApiCostUsd, summary.priceStatus);
    cost = next.cost;
    status = next.status;
  }
  return {
    items: mergeItems(summaries.flatMap((summary) => summary.items)),
    totals: mergeBreakdowns(summaries.flatMap((summary) => summary.totals)),
    coverageGaps: mergeGaps(summaries.flatMap((summary) => summary.coverageGaps)),
    estimatedApiCostUsd: cost,
    priceStatus: status,
  };
}

export const emptyRepeatedInputTokens = (): UsageRepeatedInputTokenAttribution => ({
  ...EMPTY_TOKENS,
});
