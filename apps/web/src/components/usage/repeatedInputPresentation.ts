import type {
  UsageRepeatedInputBreakdown,
  UsageRepeatedInputItem,
  UsageRepeatedInputTokenAttribution,
} from "@t3tools/contracts";

export const SOURCE_LABELS = {
  skill: "Skills",
  instruction: "Instructions",
  developerBlock: "Developer blocks",
  toolOperation: "Tool operations",
} as const;
export const CONFIDENCE_LABELS = {
  confirmedPayload: "Confirmed payload",
  likelyRead: "Likely read",
  reference: "Reference only",
} as const;
export const TOKEN_SEGMENTS = [
  { key: "exact", label: "Exact", color: "bg-primary" },
  { key: "estimated", label: "Estimated", color: "bg-amber-500" },
  { key: "cached", label: "Cached", color: "bg-sky-500" },
  { key: "cacheWrite", label: "Cache-write", color: "bg-violet-500" },
  { key: "unknown", label: "Unknown", color: "bg-muted-foreground" },
] as const;

export type ComparisonDimension = "source" | "model" | "project" | "time";
export type ComparisonMetric = "tokens" | "value" | "occurrences";
export type ComparisonGroup = {
  key: string;
  label: string;
  tokens: UsageRepeatedInputTokenAttribution;
  occurrences: number;
  value: number | null;
  incomplete: boolean;
  sinceDay: string;
  untilDay: string;
};
export const emptyTokens = (): UsageRepeatedInputTokenAttribution => ({
  exact: 0,
  estimated: 0,
  cached: 0,
  cacheWrite: 0,
  unknown: 0,
});
export function totalTokens(tokens: UsageRepeatedInputTokenAttribution): number {
  return tokens.exact + tokens.estimated + tokens.cached + tokens.cacheWrite + tokens.unknown;
}
export function addTokens(
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
export function payloadValue(item: UsageRepeatedInputItem): number | null {
  const priced = item.modelCosts.flatMap((model) =>
    model.estimatedApiCostUsd === null ? [] : [model.estimatedApiCostUsd],
  );
  return priced.length === 0 ? null : priced.reduce((sum, value) => sum + value, 0);
}
export function projectLabel(row: UsageRepeatedInputBreakdown): string {
  return `${row.project ?? "Unknown project"} / ${row.environment ?? "Unknown environment"}`;
}
export function periodLabel(sinceDay: string, untilDay: string): string {
  return sinceDay === untilDay ? sinceDay : `${sinceDay} to ${untilDay}`;
}
function mergeGroup(left: ComparisonGroup, right: ComparisonGroup): ComparisonGroup {
  return {
    ...left,
    tokens: addTokens(left.tokens, right.tokens),
    occurrences: left.occurrences + right.occurrences,
    value:
      left.value === null && right.value === null ? null : (left.value ?? 0) + (right.value ?? 0),
    incomplete: left.incomplete || right.incomplete,
    sinceDay: left.sinceDay < right.sinceDay ? left.sinceDay : right.sinceDay,
    untilDay: left.untilDay > right.untilDay ? left.untilDay : right.untilDay,
  };
}
/** Groups server rollups without distributing interval totals into invented daily values. */
export function comparisonGroups(
  rows: readonly UsageRepeatedInputBreakdown[],
  dimension: ComparisonDimension,
): ComparisonGroup[] {
  const groups = new Map<string, ComparisonGroup>();
  for (const row of rows) {
    const key =
      dimension === "source"
        ? row.sourceKind
        : dimension === "model"
          ? JSON.stringify(row.model)
          : dimension === "project"
            ? JSON.stringify([row.project, row.environment])
            : JSON.stringify([row.sinceDay, row.untilDay]);
    const group: ComparisonGroup = {
      key,
      label:
        dimension === "source"
          ? SOURCE_LABELS[row.sourceKind]
          : dimension === "model"
            ? (row.model ?? "Unknown model")
            : dimension === "project"
              ? projectLabel(row)
              : periodLabel(row.sinceDay, row.untilDay),
      tokens: row.directTokens,
      occurrences: row.occurrences,
      value: row.estimatedApiCostUsd,
      incomplete: row.priceStatus === "unpriced" || row.estimatedApiCostUsd === null,
      sinceDay: row.sinceDay,
      untilDay: row.untilDay,
    };
    const previous = groups.get(key);
    groups.set(key, previous === undefined ? group : mergeGroup(previous, group));
  }
  const result = [...groups.values()];
  if (dimension !== "time") return result;
  result.sort(
    (a, b) => a.sinceDay.localeCompare(b.sinceDay) || a.untilDay.localeCompare(b.untilDay),
  );
  const stride = Math.ceil(result.length / 48);
  if (stride <= 1) return result;
  const buckets: ComparisonGroup[] = [];
  for (let index = 0; index < result.length; index += stride) {
    const combined = result.slice(index, index + stride).reduce(mergeGroup);
    buckets.push({ ...combined, label: periodLabel(combined.sinceDay, combined.untilDay) });
  }
  return buckets;
}
export function comparisonValue(group: ComparisonGroup, metric: ComparisonMetric): number | null {
  return metric === "tokens"
    ? totalTokens(group.tokens)
    : metric === "value"
      ? group.value
      : group.occurrences;
}
