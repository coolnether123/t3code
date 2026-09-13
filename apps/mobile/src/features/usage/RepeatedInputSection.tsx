import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type {
  UsageRepeatedInputSummary,
  UsageRepeatedInputTokenAttribution,
  UsageRepeatedInputBreakdown,
} from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { SettingsSection } from "../settings/components/SettingsSection";

export type RepeatedInputSectionData = UsageRepeatedInputSummary;
type Tokens = UsageRepeatedInputTokenAttribution;
type ModelValue = { model: string; valueUsd: number | null; priced: boolean };
type Group = {
  label: string;
  count: number;
  tokens: number;
  valueUsd: number | null;
  priced: boolean;
};
type Item = {
  id: string;
  name: string;
  kind: string;
  contentHash: string;
  revisionHash: string | null;
  first: string;
  last: string;
  occurrences: number;
  sessions: number;
  turns: number;
  confidenceLevel: string;
  confidence: ReadonlyArray<{ label: string; count: number }>;
  direct: Tokens;
  fullSessionTokens: Tokens;
  fullSession: number;
  project: string;
  models: ReadonlyArray<ModelValue>;
};
export type RepeatedInputView = {
  items: ReadonlyArray<Item>;
  itemCount: number;
  occurrences: number;
  direct: Tokens;
  valueUsd: number | null;
  valuePriced: boolean;
  sourceKinds: ReadonlyArray<Group>;
  models: ReadonlyArray<Group>;
  projects: ReadonlyArray<Group>;
  dates: ReadonlyArray<Group>;
  coverage: { status: string | null; gaps: ReadonlyArray<string>; unknown: number | null };
};
const SOURCE_LABELS = {
  skill: "Skills",
  instruction: "Instructions",
  developerBlock: "Developer blocks",
  toolOperation: "Tool operations",
};
const CONFIDENCE_LABELS = {
  reference: "Reference only",
  likelyRead: "Likely read",
  confirmedPayload: "Confirmed payload",
};
function totalTokens(tokens: Tokens): number {
  return tokens.exact + tokens.estimated + tokens.cached + tokens.cacheWrite + tokens.unknown;
}
function projectLabel(row: UsageRepeatedInputBreakdown): string {
  return [row.project ?? "Unknown project", row.environment ?? "Unknown environment"].join(" / ");
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
        ? SOURCE_LABELS[row.sourceKind]
        : dimension === "model"
          ? (row.model ?? "Unknown model")
          : dimension === "project"
            ? projectLabel(row)
            : row.sinceDay === row.untilDay
              ? row.sinceDay
              : row.sinceDay + " to " + row.untilDay;
    const previous = result.get(key);
    const cost = row.estimatedApiCostUsd;
    result.set(key, {
      label,
      count: (previous?.count ?? 0) + row.occurrences,
      tokens: (previous?.tokens ?? 0) + totalTokens(row.directTokens),
      valueUsd:
        cost === null && (previous?.valueUsd ?? null) === null
          ? null
          : (previous?.valueUsd ?? 0) + (cost ?? 0),
      priced: previous?.priced !== false && row.priceStatus !== "unpriced" && cost !== null,
    });
  }
  return [...result.values()].sort((a, b) => b.tokens - a.tokens);
}
export function normalizeRepeatedInput(
  data?: UsageRepeatedInputSummary | null,
): RepeatedInputView | null {
  if (data == null) return null;
  const items = data.items.map((item): Item => ({
    id: item.sourceKind + ":" + item.contentHash,
    name: item.displayName,
    kind: SOURCE_LABELS[item.sourceKind],
    contentHash: item.contentHash,
    revisionHash: item.fileRevisionHash,
    first: item.firstObservedAt,
    last: item.lastObservedAt,
    occurrences: item.occurrences,
    sessions: item.affectedSessions,
    turns: item.affectedTurns,
    confidenceLevel: CONFIDENCE_LABELS[item.confidence],
    confidence: Object.entries(item.confidenceCounts).map(([key, count]) => ({
      label: CONFIDENCE_LABELS[key as keyof typeof CONFIDENCE_LABELS],
      count,
    })),
    direct: item.directTokens,
    fullSessionTokens: item.fullSessionInputTokens,
    fullSession: totalTokens(item.fullSessionInputTokens),
    project: [...new Set(item.breakdowns.map(projectLabel))].join("; ") || "Unknown",
    models: item.modelCosts.map((model) => ({
      model: model.model,
      valueUsd: model.estimatedApiCostUsd,
      priced: model.priceStatus !== "unpriced" && model.estimatedApiCostUsd !== null,
    })),
  }));
  const direct = { exact: 0, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 };
  let occurrences = 0;
  for (const item of items) {
    occurrences += item.occurrences;
    for (const key of ["exact", "estimated", "cached", "cacheWrite", "unknown"] as const)
      direct[key] += item.direct[key];
  }
  return {
    items,
    itemCount: items.length,
    occurrences,
    direct,
    valueUsd: data.estimatedApiCostUsd,
    valuePriced: data.priceStatus !== "unpriced",
    sourceKinds: grouped(data.totals, "source"),
    models: grouped(data.totals, "model"),
    projects: grouped(data.totals, "project"),
    dates: grouped(data.totals, "date"),
    coverage: {
      status: null,
      gaps: data.coverageGaps.map((gap) => gap.message + " " + formatCount(gap.count)),
      unknown:
        data.coverageGaps
          .filter((gap) => gap.reason === "unattributed")
          .reduce((sum, gap) => sum + gap.count, 0) || null,
    },
  };
}

function displayDate(value: string | null): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
function shortHash(value: string | null): string {
  return value === null
    ? "Unknown"
    : value.length > 16
      ? `${value.slice(0, 8)}…${value.slice(-5)}`
      : value;
}
function value(valueUsd: number | null, priced = valueUsd !== null): string {
  return valueUsd === null
    ? "Unpriced"
    : `${formatUsd(valueUsd)}${priced ? "" : " priced subtotal"}`;
}

function TokenRow({ direct }: { readonly direct: Tokens }) {
  return (
    <View className="flex-row flex-wrap gap-y-2">
      {(
        [
          ["Exact", direct.exact],
          ["Estimated", direct.estimated],
          ["Cached", direct.cached],
          ["Cache-write", direct.cacheWrite],
          ["Unknown", direct.unknown],
        ] as const
      ).map(([label, count]) => (
        <View key={label} className="w-1/2">
          <Text className="text-xs text-foreground-tertiary">{label}</Text>
          <Text className="text-sm tabular-nums text-foreground">
            {count === null ? "Unknown" : formatTokens(count)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function GroupList({
  title,
  groups,
}: {
  readonly title: string;
  readonly groups: ReadonlyArray<Group>;
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
            {entry.count === null ? "Unknown" : formatCount(entry.count)}
          </Text>
          <Text className="text-xs tabular-nums text-foreground-muted">
            {entry.tokens === null ? "Unknown" : formatTokens(entry.tokens)}
          </Text>
          <Text className="text-xs tabular-nums text-foreground">
            {value(entry.valueUsd, entry.priced)}
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

function ItemCard({ item }: { readonly item: Item }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="border-t border-border-subtle px-4 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
      >
        <View className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-base text-foreground" numberOfLines={1}>
              {item.name}
            </Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {item.kind} · {shortHash(item.contentHash)}
            </Text>
          </View>
          <Text className="text-xs text-foreground-muted">
            {item.occurrences === null ? "Unknown" : formatCount(item.occurrences)}×
          </Text>
          <Text className="text-xs text-foreground-tertiary">{expanded ? "Hide" : "Details"}</Text>
        </View>
      </Pressable>
      {expanded ? (
        <View className="mt-3 gap-3 rounded-2xl bg-subtle p-3">
          <View className="gap-1">
            <Text className="text-xs text-foreground-muted">Stable content hash</Text>
            <Text className="font-mono text-xs text-foreground" selectable>
              {item.contentHash ?? "Unknown"}
            </Text>
            <Text className="text-xs text-foreground-muted">File revision/hash</Text>
            <Text className="font-mono text-xs text-foreground" selectable>
              {item.revisionHash ?? "Unknown"}
            </Text>
          </View>
          <View className="flex-row flex-wrap gap-y-2">
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">First observed</Text>
              <Text className="text-sm text-foreground">{displayDate(item.first)}</Text>
            </View>
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">Last observed</Text>
              <Text className="text-sm text-foreground">{displayDate(item.last)}</Text>
            </View>
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">Sessions / turns</Text>
              <Text className="text-sm tabular-nums text-foreground">
                {item.sessions === null ? "Unknown" : formatCount(item.sessions)} /{" "}
                {item.turns === null ? "Unknown" : formatCount(item.turns)}
              </Text>
            </View>
            <View className="w-1/2">
              <Text className="text-xs text-foreground-muted">Project/environment</Text>
              <Text className="text-sm text-foreground" numberOfLines={1}>
                {item.project ?? "Unknown"}
              </Text>
            </View>
          </View>
          <View className="gap-1">
            <Text className="text-xs font-t3-medium text-foreground">
              Direct payload input tokens
            </Text>
            <TokenRow direct={item.direct} />
          </View>
          <View className="flex-row gap-4">
            <View className="flex-1">
              <Text className="text-xs text-foreground-muted">Full session input</Text>
              <Text className="text-sm tabular-nums text-foreground">
                {item.fullSession === null ? "Unknown" : formatTokens(item.fullSession)}
              </Text>
            </View>
          </View>
          <View className="gap-1">
            <Text className="text-xs font-t3-medium text-foreground">
              Full affected session input breakdown
            </Text>
            <TokenRow direct={item.fullSessionTokens} />
            <Text className="text-xs text-foreground-muted">
              Session context overlaps across payloads. It does not represent this payload's cost.
            </Text>
          </View>
          <View className="gap-1">
            <Text className="text-xs font-t3-medium text-foreground">Confidence</Text>
            {item.confidenceLevel !== null ? (
              <Text className="text-xs text-foreground">Overall: {item.confidenceLevel}</Text>
            ) : null}
            {item.confidence.length === 0 ? (
              <Text className="text-xs text-foreground-muted">Unknown</Text>
            ) : (
              item.confidence.map((entry) => (
                <Text key={entry.label} className="text-xs text-foreground-muted">
                  {entry.label}: {entry.count === null ? "Unknown" : formatCount(entry.count)}
                </Text>
              ))
            )}
          </View>
          <View className="gap-1">
            <Text className="text-xs font-t3-medium text-foreground">
              Estimated API-equivalent value
            </Text>
            {item.models.length === 0 ? (
              <Text className="text-xs text-foreground-muted">Unpriced</Text>
            ) : (
              item.models.map((model) => (
                <View key={model.model} className="flex-row justify-between gap-2">
                  <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                    {model.model}
                  </Text>
                  <Text className="text-xs tabular-nums text-foreground">
                    {value(model.valueUsd, model.priced)}
                  </Text>
                </View>
              ))
            )}
            <Text className="text-[11px] text-foreground-tertiary">
              Estimate only. This is not a charge, subscription balance, or reset consumption.
            </Text>
          </View>
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
    <SettingsSection title="Repeated input" card>
      <View className="gap-4 p-4">
        <Text className="text-sm leading-5 text-foreground-muted">
          Recurring skills, instruction files, reusable developer blocks, and repeatable tool
          payloads are attributed separately from full session input. Raw transcript text stays
          local.
        </Text>
        {view.coverage.gaps.length > 0 || view.coverage.unknown !== null ? (
          <View className="gap-1 rounded-2xl bg-subtle p-3">
            <Text className="text-xs font-t3-medium text-foreground">
              Coverage and unknown-attribution gaps
            </Text>
            {view.coverage.unknown !== null ? (
              <Text className="text-xs text-foreground-muted">
                {formatCount(view.coverage.unknown)} observations could not be attributed to one
                repeated payload.
              </Text>
            ) : null}
            {view.coverage.gaps.map((gap) => (
              <Text key={gap} className="text-xs text-foreground-muted">
                {gap}
              </Text>
            ))}
          </View>
        ) : null}
        {view.coverage.status ? (
          <Text className="text-xs text-foreground-tertiary">Coverage: {view.coverage.status}</Text>
        ) : null}
        <View className="flex-row flex-wrap gap-y-3">
          <View className="w-1/2">
            <Text className="text-xs text-foreground-muted">Tracked items</Text>
            <Text className="text-xl tabular-nums text-foreground">
              {formatCount(view.itemCount)}
            </Text>
          </View>
          <View className="w-1/2">
            <Text className="text-xs text-foreground-muted">Occurrences</Text>
            <Text className="text-xl tabular-nums text-foreground">
              {view.occurrences === null ? "Unknown" : formatCount(view.occurrences)}
            </Text>
          </View>
          <View className="w-1/2">
            <Text className="text-xs text-foreground-muted">Direct payload input</Text>
            <Text className="text-xl tabular-nums text-foreground">
              {directTotal === null ? "Unknown" : formatTokens(directTotal)}
            </Text>
          </View>
        </View>
        <View className="gap-1">
          <Text className="text-sm font-t3-medium text-foreground">
            Estimated API-equivalent value
          </Text>
          <Text className="text-2xl tabular-nums text-foreground">
            {value(view.valueUsd, view.valuePriced)}
          </Text>
          <Text className="text-xs text-foreground-tertiary">
            Combined estimate across tracked payloads. It is not a charge, subscription balance, or
            reset consumption. Unknown models and missing prices stay unpriced.
            {!view.valuePriced && view.valueUsd !== null
              ? " Pricing is incomplete; the subtotal includes only priced input."
              : ""}
          </Text>
        </View>
      </View>
      {view.items.length === 0 ? (
        <Text className="border-t border-border-subtle px-4 py-3 text-sm text-foreground-muted">
          No repeated payload was confirmed in this window.
        </Text>
      ) : (
        <View>
          {view.items.slice(0, 50).map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
          {view.items.length > 50 ? (
            <Text className="border-t border-border-subtle px-4 py-3 text-xs text-foreground-tertiary">
              Showing the first 50 payloads. Totals include all tracked items.
            </Text>
          ) : null}
        </View>
      )}
      <View className="gap-4 px-4 pb-4">
        <GroupList title="By source kind" groups={view.sourceKinds} />
        <GroupList title="By model" groups={view.models} />
        <GroupList title="By project/environment" groups={view.projects} />
        <GroupList title="By date" groups={view.dates} />
      </View>
    </SettingsSection>
  );
}
