import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type {
  UsageRepeatedInputCatalogItem,
  UsageRepeatedInputConfidence,
  UsageRepeatedInputItem,
  UsageRepeatedInputPriceStatus,
  UsageRepeatedInputSourceKind,
  UsageRepeatedInputSummary,
  UsageRepeatedInputTokenAttribution,
  UsageRepeatedInputBreakdown,
} from "@t3tools/contracts";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { SettingsSection } from "../settings/components/SettingsSection";

export type RepeatedInputSectionData = UsageRepeatedInputSummary;
export type Tokens = UsageRepeatedInputTokenAttribution;
export type RepeatedInputRow = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly sourceKind: UsageRepeatedInputSourceKind;
  readonly contentHash: string;
  readonly revisionHash: string | null;
  readonly byteLength: number | null;
  readonly tokenCount: number | null;
  readonly observed: boolean;
  readonly first: string | null;
  readonly last: string | null;
  readonly occurrences: number;
  readonly sessions: number;
  readonly turns: number;
  readonly confidenceLevel: string | null;
  readonly confidence: ReadonlyArray<{ readonly label: string; readonly count: number }>;
  readonly confidenceCounts: UsageRepeatedInputItem["confidenceCounts"];
  readonly direct: Tokens;
  readonly fullSessionTokens: Tokens;
  readonly models: ReadonlyArray<{
    readonly model: string;
    readonly directTokens: Tokens;
    readonly valueUsd: number | null;
    readonly priceStatus: UsageRepeatedInputPriceStatus;
    readonly occurrences: number;
  }>;
  readonly projectLabels: ReadonlyArray<string>;
  readonly estimatedApiCostUsd: number | null;
  readonly priceStatus: UsageRepeatedInputItem["modelCosts"][number]["priceStatus"];
};
type Group = {
  readonly label: string;
  readonly count: number;
  readonly tokens: number;
  readonly valueUsd: number | null;
  readonly priced: boolean;
};

export type RepeatedInputView = {
  readonly catalog: ReadonlyArray<RepeatedInputRow>;
  readonly catalogAvailable: boolean;
  readonly items: ReadonlyArray<RepeatedInputRow>;
  readonly itemCount: number;
  readonly catalogCount: number;
  readonly occurrences: number;
  readonly direct: Tokens;
  readonly valueUsd: number | null;
  readonly valuePriced: boolean;
  readonly sourceKinds: ReadonlyArray<Group>;
  readonly models: ReadonlyArray<Group>;
  readonly projects: ReadonlyArray<Group>;
  readonly dates: ReadonlyArray<Group>;
  readonly coverage: {
    readonly status: string | null;
    readonly gaps: ReadonlyArray<string>;
    readonly unknown: number | null;
  };
};

const SOURCE_LABELS: Record<UsageRepeatedInputSourceKind, string> = {
  skill: "Skills",
  instruction: "Instructions",
  developerBlock: "Developer blocks",
  toolOperation: "Tool operations",
};
const CONFIDENCE_LABELS: Record<UsageRepeatedInputConfidence, string> = {
  reference: "Reference only",
  likelyRead: "Likely read",
  confirmedPayload: "Confirmed payload",
};
const CONFIDENCE_OPTIONS: readonly (UsageRepeatedInputConfidence | "all")[] = [
  "all",
  "confirmedPayload",
  "likelyRead",
  "reference",
];
const SOURCE_OPTIONS: readonly (UsageRepeatedInputSourceKind | "all")[] = [
  "all",
  "skill",
  "instruction",
  "developerBlock",
  "toolOperation",
];
const PAGE_SIZE = 12;

type RowSort = "name" | "recent" | "tokens" | "occurrences" | "value" | "size";
type RowStatus = "all" | "observed" | "never";

function emptyTokens(): Tokens {
  return { exact: 0, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 };
}

export function totalTokens(tokens: Tokens): number {
  return tokens.exact + tokens.estimated + tokens.cached + tokens.cacheWrite + tokens.unknown;
}

function addTokens(left: Tokens, right: Tokens): Tokens {
  return {
    exact: left.exact + right.exact,
    estimated: left.estimated + right.estimated,
    cached: left.cached + right.cached,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    unknown: left.unknown + right.unknown,
  };
}

function projectLabel(row: UsageRepeatedInputBreakdown): string {
  return `${row.project ?? "Unknown project"} / ${row.environment ?? "Unknown environment"}`;
}

function sourceLabel(sourceKind: UsageRepeatedInputSourceKind): string {
  return SOURCE_LABELS[sourceKind];
}

function confidenceLabel(confidence: UsageRepeatedInputConfidence | null): string | null {
  return confidence === null ? null : CONFIDENCE_LABELS[confidence];
}

function rowKey(
  sourceKind: UsageRepeatedInputSourceKind,
  contentHash: string,
  revisionHash: string | null,
): string {
  return `${sourceKind}:${contentHash}:${revisionHash ?? ""}`;
}

function confidenceEntries(
  counts: UsageRepeatedInputItem["confidenceCounts"],
): ReadonlyArray<{ readonly label: string; readonly count: number }> {
  return (Object.keys(CONFIDENCE_LABELS) as UsageRepeatedInputConfidence[]).map((key) => ({
    label: CONFIDENCE_LABELS[key],
    count: counts[key],
  }));
}

function rowFromCatalog(item: UsageRepeatedInputCatalogItem): RepeatedInputRow {
  return {
    id: rowKey(item.sourceKind, item.contentHash, item.fileRevisionHash),
    name: item.displayName,
    kind: sourceLabel(item.sourceKind),
    sourceKind: item.sourceKind,
    contentHash: item.contentHash,
    revisionHash: item.fileRevisionHash,
    byteLength: item.byteLength,
    tokenCount: item.tokenCount,
    observed: item.observed,
    first: item.firstObservedAt,
    last: item.lastObservedAt,
    occurrences: item.occurrences,
    sessions: item.affectedSessions,
    turns: item.affectedTurns,
    confidenceLevel: confidenceLabel(item.confidence),
    confidence: confidenceEntries(item.confidenceCounts),
    confidenceCounts: item.confidenceCounts,
    direct: item.directTokens,
    fullSessionTokens: item.fullSessionInputTokens,
    models: item.modelCosts.map((model) => ({
      model: model.model,
      directTokens: model.directTokens,
      valueUsd: model.estimatedApiCostUsd,
      priceStatus: model.priceStatus,
      occurrences: model.occurrences,
    })),
    projectLabels: [...new Set(item.breakdowns.map(projectLabel))],
    estimatedApiCostUsd: item.estimatedApiCostUsd,
    priceStatus: item.priceStatus,
  };
}

function rowFromItem(item: UsageRepeatedInputItem): RepeatedInputRow {
  const estimatedApiCostUsd = item.modelCosts.reduce<number | null>(
    (sum, model) =>
      model.estimatedApiCostUsd === null ? sum : (sum ?? 0) + model.estimatedApiCostUsd,
    null,
  );
  const priceStatus = item.modelCosts.some((model) => model.priceStatus === "unpriced")
    ? "unpriced"
    : item.modelCosts.some((model) => model.priceStatus === "providerReported")
      ? "providerReported"
      : "estimated";
  return {
    id: rowKey(item.sourceKind, item.contentHash, item.fileRevisionHash),
    name: item.displayName,
    kind: sourceLabel(item.sourceKind),
    sourceKind: item.sourceKind,
    contentHash: item.contentHash,
    revisionHash: item.fileRevisionHash,
    byteLength: null,
    tokenCount: null,
    observed: true,
    first: item.firstObservedAt,
    last: item.lastObservedAt,
    occurrences: item.occurrences,
    sessions: item.affectedSessions,
    turns: item.affectedTurns,
    confidenceLevel: confidenceLabel(item.confidence),
    confidence: confidenceEntries(item.confidenceCounts),
    confidenceCounts: item.confidenceCounts,
    direct: item.directTokens,
    fullSessionTokens: item.fullSessionInputTokens,
    models: item.modelCosts.map((model) => ({
      model: model.model,
      directTokens: model.directTokens,
      valueUsd: model.estimatedApiCostUsd,
      priceStatus: model.priceStatus,
      occurrences: model.occurrences,
    })),
    projectLabels: [...new Set(item.breakdowns.map(projectLabel))],
    estimatedApiCostUsd,
    priceStatus,
  };
}

function grouped(
  rows: readonly UsageRepeatedInputBreakdown[],
  dimension: "source" | "model" | "project" | "date",
): Group[] {
  const result = new Map<string, Group>();
  for (const row of rows) {
    const key =
      dimension === "project"
        ? JSON.stringify([row.project, row.environment])
        : dimension === "model"
          ? JSON.stringify(row.model)
          : dimension === "source"
            ? row.sourceKind
            : JSON.stringify([row.sinceDay, row.untilDay]);
    const label =
      dimension === "source"
        ? sourceLabel(row.sourceKind)
        : dimension === "model"
          ? (row.model ?? "Unknown model")
          : dimension === "project"
            ? projectLabel(row)
            : row.sinceDay === row.untilDay
              ? row.sinceDay
              : `${row.sinceDay} to ${row.untilDay}`;
    const previous = result.get(key);
    const valueUsd = row.estimatedApiCostUsd;
    result.set(key, {
      label,
      count: (previous?.count ?? 0) + row.occurrences,
      tokens: (previous?.tokens ?? 0) + totalTokens(row.directTokens),
      valueUsd:
        valueUsd === null && (previous?.valueUsd ?? null) === null
          ? null
          : (previous?.valueUsd ?? 0) + (valueUsd ?? 0),
      priced: previous?.priced !== false && row.priceStatus !== "unpriced" && valueUsd !== null,
    });
  }
  return [...result.values()].sort((left, right) => right.tokens - left.tokens);
}

export function normalizeRepeatedInput(
  data?: UsageRepeatedInputSummary | null,
): RepeatedInputView | null {
  if (data == null) return null;
  const items = data.items.map(rowFromItem);
  const catalog = (data.catalog ?? []).map(rowFromCatalog);
  let direct = emptyTokens();
  let occurrences = 0;
  for (const item of items) {
    occurrences += item.occurrences;
    direct = addTokens(direct, item.direct);
  }
  return {
    catalog,
    catalogAvailable: data.catalog !== undefined,
    items,
    itemCount: items.length,
    catalogCount: catalog.length,
    occurrences,
    direct,
    valueUsd: data.estimatedApiCostUsd,
    valuePriced: data.priceStatus !== "unpriced" && data.estimatedApiCostUsd !== null,
    sourceKinds: grouped(data.totals, "source"),
    models: grouped(data.totals, "model"),
    projects: grouped(data.totals, "project"),
    dates: grouped(data.totals, "date"),
    coverage: {
      status: null,
      gaps: data.coverageGaps.map((gap) => `${gap.message} ${formatCount(gap.count)}`),
      unknown:
        data.coverageGaps
          .filter((gap) => gap.reason === "unattributed")
          .reduce((sum, gap) => sum + gap.count, 0) || null,
    },
  };
}

export function priceText(
  valueUsd: number | null,
  priceStatus: RepeatedInputRow["priceStatus"],
): string {
  if (valueUsd === null) return "Unpriced (price unavailable)";
  if (priceStatus === "unpriced") return `${formatUsd(valueUsd)} priced subtotal`;
  if (priceStatus === "providerReported") return `${formatUsd(valueUsd)} provider-reported`;
  return `${formatUsd(valueUsd)} estimated`;
}

export type RepeatedInputRowFilter = {
  readonly query?: string;
  readonly sourceKind?: UsageRepeatedInputSourceKind | "all";
  readonly status?: RowStatus;
  readonly confidence?: UsageRepeatedInputConfidence | "all";
  readonly sort?: RowSort;
};

export function filterRepeatedInputRows(
  rows: readonly RepeatedInputRow[],
  filter: RepeatedInputRowFilter = {},
): RepeatedInputRow[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const sourceKind = filter.sourceKind ?? "all";
  const status = filter.status ?? "all";
  const confidence = filter.confidence ?? "all";
  const sort = filter.sort ?? "recent";
  return rows
    .filter((row) => {
      const searchText = [
        row.name,
        row.kind,
        row.contentHash,
        row.revisionHash ?? "",
        ...row.models.map((model) => model.model),
        ...row.projectLabels,
      ]
        .join("\n")
        .toLowerCase();
      return (
        (query === "" || searchText.includes(query)) &&
        (sourceKind === "all" || row.sourceKind === sourceKind) &&
        (status === "all" || (status === "observed" ? row.observed : !row.observed)) &&
        (confidence === "all" || row.confidenceCounts[confidence] > 0)
      );
    })
    .sort((left, right) => {
      if (sort === "name") {
        return (
          left.name.localeCompare(right.name) || left.contentHash.localeCompare(right.contentHash)
        );
      }
      if (sort === "size") {
        return (
          (right.byteLength ?? -1) - (left.byteLength ?? -1) || left.name.localeCompare(right.name)
        );
      }
      if (sort === "tokens") {
        return (
          totalTokens(right.direct) - totalTokens(left.direct) ||
          left.name.localeCompare(right.name)
        );
      }
      if (sort === "occurrences") {
        return right.occurrences - left.occurrences || left.name.localeCompare(right.name);
      }
      if (sort === "value") {
        return (
          (right.estimatedApiCostUsd ?? -1) - (left.estimatedApiCostUsd ?? -1) ||
          left.name.localeCompare(right.name)
        );
      }
      return (
        (right.last ?? "").localeCompare(left.last ?? "") || left.name.localeCompare(right.name)
      );
    });
}

export function paginateRepeatedInputRows<T>(
  rows: readonly T[],
  page: number,
  pageSize = PAGE_SIZE,
): { readonly page: number; readonly pageCount: number; readonly items: readonly T[] } {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  return {
    page: currentPage,
    pageCount,
    items: rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
  };
}

function displayDate(value: string | null): string {
  if (value === null) return "Never observed in this period";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function shortHash(value: string | null): string {
  if (value === null) return "Unknown";
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
}

function TokenRow({ tokens }: { readonly tokens: Tokens }) {
  return (
    <View className="flex-row flex-wrap gap-y-2">
      {(
        [
          ["Exact", tokens.exact],
          ["Estimated", tokens.estimated],
          ["Cached", tokens.cached],
          ["Cache-write", tokens.cacheWrite],
          ["Unknown", tokens.unknown],
        ] as const
      ).map(([label, count]) => (
        <View key={label} className="w-1/2">
          <Text className="text-xs text-foreground-tertiary">{label}</Text>
          <Text className="text-sm tabular-nums text-foreground">{formatTokens(count)}</Text>
        </View>
      ))}
    </View>
  );
}

function FilterChip(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={
        props.selected
          ? "min-h-10 justify-center rounded-full bg-subtle-strong px-3"
          : "min-h-10 justify-center rounded-full border border-subtle px-3"
      }
    >
      <Text
        className={
          props.selected
            ? "text-xs font-t3-medium text-foreground"
            : "text-xs text-foreground-muted"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function RowCard({ row }: { readonly row: RepeatedInputRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="border-t border-border-subtle px-4 py-3">
      <Pressable
        accessibilityLabel={`Details for ${row.name}`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
      >
        <View className="flex-row items-start gap-3">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-base text-foreground" numberOfLines={1}>
              {row.name}
            </Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {row.kind} · {row.observed ? "Observed" : "Never observed"} ·{" "}
              {shortHash(row.contentHash)}
            </Text>
          </View>
          <View className="items-end gap-0.5">
            <Text className="text-xs tabular-nums text-foreground-muted">
              {formatCount(row.occurrences)}×
            </Text>
            <Text className="text-xs text-foreground-tertiary">
              {expanded ? "Hide" : "Details"}
            </Text>
          </View>
        </View>
      </Pressable>
      {expanded ? (
        <View className="mt-3 gap-3 rounded-2xl bg-subtle p-3">
          <View className="gap-1">
            <Text className="text-xs text-foreground-muted">Observation status</Text>
            <Text className="text-sm text-foreground">
              {row.observed ? "Observed in this period" : "Never observed in this period"}
            </Text>
            <Text className="text-xs text-foreground-muted">Stable content hash</Text>
            <Text className="font-mono text-xs text-foreground" selectable>
              {row.contentHash}
            </Text>
            <Text className="text-xs text-foreground-muted">File revision/hash</Text>
            <Text className="font-mono text-xs text-foreground" selectable>
              {row.revisionHash ?? "Unknown"}
            </Text>
          </View>
          <View className="flex-row flex-wrap gap-y-2">
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">File size</Text>
              <Text className="text-sm tabular-nums text-foreground">
                {row.byteLength === null ? "Unknown" : `${formatCount(row.byteLength)} bytes`}
              </Text>
            </View>
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">Content token count</Text>
              <Text className="text-sm tabular-nums text-foreground">
                {row.tokenCount === null ? "Unknown" : formatTokens(row.tokenCount)}
              </Text>
            </View>
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">First observed</Text>
              <Text className="text-sm text-foreground">{displayDate(row.first)}</Text>
            </View>
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">Last observed</Text>
              <Text className="text-sm text-foreground">{displayDate(row.last)}</Text>
            </View>
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">Sessions / turns</Text>
              <Text className="text-sm tabular-nums text-foreground">
                {formatCount(row.sessions)} / {formatCount(row.turns)}
              </Text>
            </View>
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">Price state</Text>
              <Text className="text-sm text-foreground">
                {row.priceStatus === "unpriced"
                  ? "Unpriced (price unavailable)"
                  : row.priceStatus === "providerReported"
                    ? "Provider reported"
                    : "Estimated"}
              </Text>
            </View>
          </View>
          <View className="gap-1">
            <Text className="text-xs font-t3-medium text-foreground">Direct payload input</Text>
            {!row.observed ? (
              <Text className="text-xs text-foreground-muted">
                No direct input was observed. File token size does not establish input usage.
              </Text>
            ) : null}
            <TokenRow tokens={row.direct} />
          </View>
          <View className="gap-1">
            <Text className="text-xs font-t3-medium text-foreground">Observation confidence</Text>
            {row.confidenceLevel === null ? (
              <Text className="text-xs text-foreground-muted">
                No observation evidence in this period.
              </Text>
            ) : (
              row.confidence.map((entry) => (
                <Text key={entry.label} className="text-xs text-foreground-muted">
                  {entry.label}: {formatCount(entry.count)}
                </Text>
              ))
            )}
          </View>
          <View className="gap-1">
            <Text className="text-xs font-t3-medium text-foreground">
              Estimated API-equivalent value by model
            </Text>
            {row.models.length === 0 ? (
              <Text className="text-xs text-foreground-muted">
                Unpriced. No observed model input is available.
              </Text>
            ) : (
              row.models.map((model) => (
                <View key={model.model} className="flex-row items-start justify-between gap-2">
                  <View className="min-w-0 flex-1">
                    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                      {model.model}
                    </Text>
                    <Text className="text-[11px] text-foreground-tertiary">
                      {formatTokens(totalTokens(model.directTokens))} direct tokens
                    </Text>
                  </View>
                  <Text className="text-xs tabular-nums text-foreground">
                    {priceText(model.valueUsd, model.priceStatus)}
                  </Text>
                </View>
              ))
            )}
            <Text className="text-[11px] text-foreground-tertiary">
              Estimate only. It is not a charge, subscription balance, or reset consumption.
            </Text>
          </View>
          <View className="gap-1">
            <Text className="text-xs font-t3-medium text-foreground">Project/environment</Text>
            {row.projectLabels.length === 0 ? (
              <Text className="text-xs text-foreground-muted">Unknown</Text>
            ) : (
              row.projectLabels.map((label) => (
                <Text key={label} className="text-xs text-foreground-muted" numberOfLines={2}>
                  {label}
                </Text>
              ))
            )}
          </View>
          {row.observed ? (
            <View className="gap-1 border-t border-border-subtle pt-3">
              <Text className="text-xs font-t3-medium text-foreground">
                Full affected session input
              </Text>
              <Text className="text-sm tabular-nums text-foreground">
                {formatTokens(totalTokens(row.fullSessionTokens))}
              </Text>
              <Text className="text-xs text-foreground-muted">
                Session context overlaps across payloads. It does not represent this payload&apos;s
                cost.
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function GroupList({
  title,
  groups,
}: {
  readonly title: string;
  readonly groups: readonly Group[];
}) {
  if (groups.length === 0) return null;
  return (
    <View className="gap-2 border-t border-border-subtle pt-3">
      <Text className="text-xs font-t3-medium text-foreground-muted">{title}</Text>
      {groups.slice(0, 20).map((entry) => (
        <View key={`${title}:${entry.label}`} className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
            {entry.label}
          </Text>
          <Text className="text-xs tabular-nums text-foreground-muted">
            {formatCount(entry.count)}
          </Text>
          <Text className="text-xs tabular-nums text-foreground-muted">
            {formatTokens(entry.tokens)}
          </Text>
          <Text className="text-xs tabular-nums text-foreground">
            {priceText(entry.valueUsd, entry.priced ? "estimated" : "unpriced")}
          </Text>
        </View>
      ))}
      {groups.length > 20 ? (
        <Text className="text-xs text-foreground-tertiary">
          Showing the first 20 groups. Totals include all groups.
        </Text>
      ) : null}
    </View>
  );
}

function RepeatedInputList({
  title,
  description,
  rows,
  catalog,
}: {
  readonly title: string;
  readonly description: string;
  readonly rows: readonly RepeatedInputRow[];
  readonly catalog: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sourceKind, setSourceKind] = useState<UsageRepeatedInputSourceKind | "all">("all");
  const [status, setStatus] = useState<RowStatus>("all");
  const [confidence, setConfidence] = useState<UsageRepeatedInputConfidence | "all">("all");
  const [sort, setSort] = useState<RowSort>(catalog ? "name" : "recent");
  const [page, setPage] = useState(0);
  const filtered = useMemo(
    () =>
      filterRepeatedInputRows(rows, {
        query,
        sourceKind: catalog ? "skill" : sourceKind,
        status: catalog ? status : "all",
        confidence,
        sort,
      }),
    [catalog, confidence, query, rows, sort, sourceKind, status],
  );
  const paged = paginateRepeatedInputRows(filtered, page);
  const first = filtered.length === 0 ? 0 : paged.page * PAGE_SIZE + 1;
  const last = Math.min((paged.page + 1) * PAGE_SIZE, filtered.length);
  const sourceOptions = catalog ? (["all"] as const) : SOURCE_OPTIONS;
  const hasFilters =
    query.length > 0 ||
    sourceKind !== "all" ||
    status !== "all" ||
    confidence !== "all" ||
    sort !== (catalog ? "name" : "recent");
  const clearFilters = () => {
    setQuery("");
    setSourceKind("all");
    setStatus("all");
    setConfidence("all");
    setSort(catalog ? "name" : "recent");
    setPage(0);
  };
  return (
    <View className="gap-3 border-t border-border-subtle pt-4">
      <View className="gap-1">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="text-base font-t3-medium text-foreground">
            {title} ({formatCount(rows.length)})
          </Text>
          <Text className="text-xs text-foreground-muted">
            {catalog ? "Current revisions" : "Observed history"}
          </Text>
        </View>
        <Text className="text-xs leading-5 text-foreground-muted">{description}</Text>
      </View>
      <TextInput
        accessibilityLabel={catalog ? "Search skill catalog" : "Search repeated input history"}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={(value) => {
          setQuery(value);
          setPage(0);
        }}
        placeholder={
          catalog ? "Find a skill, revision, model, or hash" : "Find a payload, model, or hash"
        }
        value={query}
      />
      <View className="gap-2">
        <Text className="text-xs text-foreground-muted">{catalog ? "Observation" : "Source"}</Text>
        <View className="flex-row flex-wrap gap-2">
          {sourceOptions.map((option) => (
            <FilterChip
              key={option}
              label={
                option === "all" ? (catalog ? "All skills" : "All sources") : sourceLabel(option)
              }
              selected={catalog ? status === "all" && option === "all" : sourceKind === option}
              onPress={() => {
                if (catalog) {
                  setStatus("all");
                  setPage(0);
                  return;
                }
                setSourceKind(option);
                setPage(0);
              }}
            />
          ))}
          {catalog
            ? (
                [
                  ["observed", "Observed"],
                  ["never", "Never observed"],
                ] as const
              ).map(([value, label]) => (
                <FilterChip
                  key={value}
                  label={label}
                  selected={status === value}
                  onPress={() => {
                    setStatus(value);
                    setPage(0);
                  }}
                />
              ))
            : null}
        </View>
      </View>
      <View className="gap-2">
        <Text className="text-xs text-foreground-muted">Evidence</Text>
        <View className="flex-row flex-wrap gap-2">
          {CONFIDENCE_OPTIONS.map((option) => (
            <FilterChip
              key={option}
              label={option === "all" ? "All evidence" : CONFIDENCE_LABELS[option]}
              selected={confidence === option}
              onPress={() => {
                setConfidence(option);
                setPage(0);
              }}
            />
          ))}
        </View>
      </View>
      <View className="gap-2">
        <Text className="text-xs text-foreground-muted">Sort</Text>
        <View className="flex-row flex-wrap gap-2">
          {(catalog
            ? ([
                ["name", "Name"],
                ["size", "Largest file"],
                ["tokens", "Most direct tokens"],
                ["recent", "Most recent"],
              ] as const)
            : ([
                ["recent", "Most recent"],
                ["tokens", "Most direct tokens"],
                ["occurrences", "Most occurrences"],
                ["value", "Highest estimate"],
              ] as const)
          ).map(([value, label]) => (
            <FilterChip
              key={value}
              label={label}
              selected={sort === value}
              onPress={() => {
                setSort(value);
                setPage(0);
              }}
            />
          ))}
        </View>
      </View>
      {hasFilters ? (
        <Pressable
          accessibilityRole="button"
          onPress={clearFilters}
          className="min-h-10 justify-center self-start"
        >
          <Text className="text-xs text-foreground-muted">Clear filters</Text>
        </Pressable>
      ) : null}
      <Text className="text-[11px] leading-4 text-foreground-tertiary">
        Evidence filters match any observation. Totals remain for the complete selected period.
      </Text>
      {filtered.length === 0 ? (
        <Text className="py-4 text-sm text-foreground-muted">
          {rows.length === 0
            ? catalog
              ? "No current skill revisions were reported."
              : "No observed repeated input was confirmed in this period."
            : catalog
              ? "No current skills match these filters."
              : "No historical observations match these filters."}
        </Text>
      ) : (
        <View className="overflow-hidden rounded-2xl border border-border-subtle">
          {paged.items.map((row) => (
            <RowCard key={row.id} row={row} />
          ))}
        </View>
      )}
      {filtered.length > 0 ? (
        <View className="flex-row items-center justify-between gap-2">
          <Pressable
            accessibilityLabel={`Previous ${catalog ? "skills" : "history"}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: paged.page === 0 }}
            disabled={paged.page === 0}
            onPress={() => setPage((current) => Math.max(0, current - 1))}
            className="min-h-10 justify-center px-2"
          >
            <Text className="text-xs text-foreground-muted">Previous</Text>
          </Pressable>
          <Text className="text-xs tabular-nums text-foreground-muted">
            {first}–{last} of {formatCount(filtered.length)}
          </Text>
          <Pressable
            accessibilityLabel={`Next ${catalog ? "skills" : "history"}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: paged.page >= paged.pageCount - 1 }}
            disabled={paged.page >= paged.pageCount - 1}
            onPress={() => setPage((current) => Math.min(paged.pageCount - 1, current + 1))}
            className="min-h-10 justify-center px-2"
          >
            <Text className="text-xs text-foreground-muted">Next</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export function RepeatedInputSection({
  data,
}: {
  readonly data?: RepeatedInputSectionData | null;
}) {
  const view = useMemo(() => normalizeRepeatedInput(data), [data]);
  if (!view) return null;
  const directTotal = totalTokens(view.direct);
  return (
    <View className="gap-5">
      <SettingsSection title="Attribution overview" card>
        <View className="gap-4 p-4">
          <Text className="text-sm leading-5 text-foreground-muted">
            Current skills stay separate from historical observed revisions. Only metadata and token
            attribution leave the computer that scanned the transcripts.
          </Text>
          {view.coverage.gaps.length > 0 ? (
            <View className="gap-1 rounded-2xl bg-subtle p-3">
              <Text className="text-xs font-t3-medium text-foreground">
                Coverage and unknown-attribution gaps
              </Text>
              {view.coverage.unknown !== null ? (
                <Text className="text-xs text-foreground-muted">
                  {formatCount(view.coverage.unknown)} unresolved attribution units could not be
                  assigned to one repeated payload.
                </Text>
              ) : null}
              {view.coverage.gaps.map((gap) => (
                <Text key={gap} className="text-xs text-foreground-muted">
                  {gap}
                </Text>
              ))}
            </View>
          ) : null}
          <View className="flex-row flex-wrap gap-y-3">
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">Current skill revisions</Text>
              <Text className="text-xl tabular-nums text-foreground">
                {formatCount(view.catalogCount)}
              </Text>
            </View>
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">Historical items</Text>
              <Text className="text-xl tabular-nums text-foreground">
                {formatCount(view.itemCount)}
              </Text>
            </View>
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">Occurrences</Text>
              <Text className="text-xl tabular-nums text-foreground">
                {formatCount(view.occurrences)}
              </Text>
            </View>
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">Direct payload input</Text>
              <Text className="text-xl tabular-nums text-foreground">
                {formatTokens(directTotal)}
              </Text>
            </View>
          </View>
          <View className="gap-1">
            <Text className="text-sm font-t3-medium text-foreground">
              {view.valueUsd === null || !view.valuePriced
                ? "API-equivalent value"
                : "Estimated API-equivalent value"}
            </Text>
            <Text className="text-2xl tabular-nums text-foreground">
              {priceText(view.valueUsd, data?.priceStatus ?? "unpriced")}
            </Text>
            <Text className="text-xs text-foreground-tertiary">
              Unknown models and missing prices stay unpriced. This is an estimate, not a charge,
              subscription balance, or reset consumption.
              {!view.valuePriced && view.valueUsd !== null
                ? " Pricing is incomplete; the subtotal includes only priced input."
                : ""}
            </Text>
          </View>
          <View className="gap-1">
            <Text className="text-sm font-t3-medium text-foreground">Direct token attribution</Text>
            <TokenRow tokens={view.direct} />
          </View>
        </View>
        <View className="gap-4 px-4 pb-4">
          <GroupList title="By source kind" groups={view.sourceKinds} />
          <GroupList title="By model" groups={view.models} />
          <GroupList title="By project/environment" groups={view.projects} />
          <GroupList title="By date" groups={view.dates} />
        </View>
      </SettingsSection>
      <SettingsSection title="Current skill catalog" card>
        <View className="px-4">
          {view.catalogAvailable ? (
            <RepeatedInputList
              catalog
              description="Every currently discoverable skill revision is listed, including skills with no observation in this period. File size and content token count describe the installed revision, not transcript usage."
              rows={view.catalog}
              title="Installed skills"
            />
          ) : (
            <Text className="py-4 text-sm leading-5 text-foreground-muted">
              This computer did not return a current skill catalog. Historical observed revisions
              remain available below.
            </Text>
          )}
        </View>
      </SettingsSection>
      <SettingsSection title="Historical observed revisions" card>
        <View className="px-4">
          <RepeatedInputList
            catalog={false}
            description="Observed payload history, including older skill revisions and other repeated-input sources. Current skills can appear here too when they were observed in the selected period."
            rows={view.items}
            title="Observed payloads"
          />
        </View>
      </SettingsSection>
    </View>
  );
}
