import { useDeferredValue, useMemo, useState } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import type {
  UsageRepeatedInputCatalogItem,
  UsageRepeatedInputItem,
  UsageRepeatedInputSummary,
  UsageRepeatedInputTokenAttribution,
} from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import {
  addTokens,
  comparisonGroups,
  comparisonValue,
  CONFIDENCE_LABELS,
  emptyTokens,
  payloadValue,
  projectLabel,
  SOURCE_LABELS,
  TOKEN_SEGMENTS,
  totalTokens,
  type ComparisonDimension,
  type ComparisonMetric,
} from "./repeatedInputPresentation";

export type RepeatedInputSectionData = UsageRepeatedInputSummary;
type PayloadItem = UsageRepeatedInputItem | UsageRepeatedInputCatalogItem;
const integer = (value: number) => value.toLocaleString("en-US");
const money = (value: number | null) =>
  value === null
    ? "Unpriced"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(value);
const SELECT_CLASS =
  "min-h-11 min-w-0 rounded-md border border-border bg-background px-3 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const PAGE_SIZE = 12;
const DIMENSIONS = [
  ["source", "By source kind"],
  ["model", "By model"],
  ["project", "By project/environment"],
  ["time", "Over time"],
] as const;
const METRICS = [
  ["tokens", "Direct tokens"],
  ["value", "API-equivalent value"],
  ["occurrences", "Occurrences"],
] as const;

function TokenBreakdown({ tokens }: { readonly tokens: UsageRepeatedInputTokenAttribution }) {
  const total = totalTokens(tokens);
  return (
    <div className="space-y-2">
      <div
        className="flex h-2 overflow-hidden rounded-sm bg-muted"
        role="img"
        aria-label={`Direct token composition: ${TOKEN_SEGMENTS.map(({ key, label }) => `${label} ${integer(tokens[key])}`).join(", ")}`}
      >
        {TOKEN_SEGMENTS.map(({ key, color }) => (
          <span
            key={key}
            className={color}
            style={{ width: `${total === 0 ? 0 : (tokens[key] / total) * 100}%` }}
          />
        ))}
      </div>
      <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
        {TOKEN_SEGMENTS.map(({ key, label, color }) => (
          <div key={key} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2 rounded-sm", color)} />
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="tabular-nums text-foreground">{integer(tokens[key])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ConfidenceBreakdown({
  counts,
}: {
  readonly counts: UsageRepeatedInputItem["confidenceCounts"];
}) {
  const total = counts.reference + counts.likelyRead + counts.confirmedPayload;
  return (
    <div className="space-y-2">
      <div
        className="flex h-2 overflow-hidden rounded-sm bg-muted"
        role="img"
        aria-label={`Observation confidence: ${Object.entries(CONFIDENCE_LABELS)
          .map(([key, label]) => `${label} ${integer(counts[key as keyof typeof counts])}`)
          .join(", ")}`}
      >
        {(
          [
            ["confirmedPayload", "bg-emerald-500"],
            ["likelyRead", "bg-amber-500"],
            ["reference", "bg-muted-foreground"],
          ] as const
        ).map(([key, color]) => (
          <span
            key={key}
            className={color}
            style={{ width: `${total === 0 ? 0 : (counts[key] / total) * 100}%` }}
          />
        ))}
      </div>
      <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
        {Object.entries(CONFIDENCE_LABELS).map(([key, label]) => (
          <div key={key} className="flex gap-1.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="tabular-nums">{integer(counts[key as keyof typeof counts])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Comparison({ data }: { readonly data: UsageRepeatedInputSummary }) {
  const [dimension, setDimension] = useState<ComparisonDimension>("source");
  const [metric, setMetric] = useState<ComparisonMetric>("tokens");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const groups = useMemo(() => {
    const result = comparisonGroups(data.totals, dimension);
    return dimension === "time"
      ? result
      : result.sort(
          (a, b) =>
            (comparisonValue(b, metric) ?? -1) - (comparisonValue(a, metric) ?? -1) ||
            a.label.localeCompare(b.label),
        );
  }, [data.totals, dimension, metric]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(groups.length / PAGE_SIZE) - 1));
  const visible =
    dimension === "time"
      ? groups
      : groups.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const maximum = groups.reduce(
    (max, group) => Math.max(max, comparisonValue(group, metric) ?? 0),
    0,
  );
  const active = groups.find((group) => group.key === selected) ?? visible[0];
  const displayValue = (value: number | null) =>
    metric === "value"
      ? money(value)
      : value === null
        ? "Unknown"
        : metric === "tokens"
          ? formatTokens(value)
          : integer(value);
  return (
    <section
      aria-labelledby="repeated-input-comparison-heading"
      className="min-w-0 space-y-5 border-t border-border pt-6"
    >
      <div>
        <h2 id="repeated-input-comparison-heading" className="text-base font-medium">
          Compare attribution
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Select a group to inspect its token mix and estimated value.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Compare repeated input">
          {DIMENSIONS.map(([value, label]) => (
            <Button
              key={value}
              size="compact"
              className="min-h-11"
              variant={dimension === value ? "secondary" : "ghost-muted"}
              aria-pressed={dimension === value}
              onClick={() => {
                setDimension(value);
                setPage(0);
                setSelected(null);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Measure
          <select
            aria-label="Repeated input comparison metric"
            className={SELECT_CLASS}
            value={metric}
            onChange={(event) => {
              setMetric(event.target.value as ComparisonMetric);
              setPage(0);
              setSelected(null);
            }}
          >
            {METRICS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">No breakdown is available for this window.</p>
      ) : (
        <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="min-w-0 space-y-2">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>
                {dimension === "time" ? "Reported periods, oldest first" : "Largest first"}
              </span>
              <span>
                Scale:{" "}
                {displayValue(
                  groups.some((group) => comparisonValue(group, metric) !== null) ? maximum : null,
                )}
              </span>
            </div>
            {dimension === "time" ? (
              <>
                <div
                  className="flex h-36 items-end gap-1 border-b border-border"
                  role="group"
                  aria-label="Repeated input over time"
                >
                  {visible.map((group) => {
                    const value = comparisonValue(group, metric);
                    const label = `${group.label}: ${displayValue(value)}${metric === "value" && group.incomplete && value !== null ? " priced subtotal" : ""}`;
                    return (
                      <button
                        key={group.key}
                        type="button"
                        aria-label={label}
                        aria-pressed={active?.key === group.key}
                        className="group flex h-full min-w-0 flex-1 cursor-pointer items-end rounded-t-sm focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => setSelected(group.key)}
                      >
                        <span
                          className={cn(
                            "w-full rounded-t-sm",
                            active?.key === group.key
                              ? "bg-primary"
                              : "bg-primary/35 group-hover:bg-primary/60",
                            value === null && "bg-muted-foreground/30",
                          )}
                          style={{
                            height:
                              value === null || value === 0
                                ? 2
                                : Math.max(2, (value / maximum) * 100) + "%",
                          }}
                        />
                      </button>
                    );
                  })}
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{groups[0]?.sinceDay}</span>
                  <span>{groups[groups.length - 1]?.untilDay}</span>
                </div>
                <label className="flex flex-col gap-1.5 text-xs text-muted-foreground sm:hidden">
                  Inspect a period
                  <select
                    aria-label="Repeated input time period"
                    className={SELECT_CLASS}
                    value={active?.key ?? ""}
                    onChange={(event) => setSelected(event.target.value)}
                  >
                    {groups.map((group) => (
                      <option key={group.key} value={group.key}>
                        {group.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-[11px] text-muted-foreground">
                  Up to 48 groups of reported periods. Gaps have no observation; interval totals are
                  not daily rates. Select a bar for its date range.
                </p>
              </>
            ) : (
              <div className="space-y-1" role="group" aria-label="Repeated input comparison chart">
                {visible.map((group) => {
                  const value = comparisonValue(group, metric);
                  return (
                    <button
                      key={group.key}
                      type="button"
                      aria-pressed={active?.key === group.key}
                      onClick={() => setSelected(group.key)}
                      className={cn(
                        "grid min-h-11 w-full cursor-pointer grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-x-3 gap-y-2 rounded-md px-2 py-3 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-[minmax(6rem,1fr)_minmax(3rem,1.4fr)_5.5rem]",
                        active?.key === group.key && "bg-muted/60",
                      )}
                    >
                      <span className="break-words sm:truncate">{group.label}</span>
                      <span
                        aria-hidden
                        className="col-span-2 row-start-2 h-2 overflow-hidden rounded-sm bg-muted sm:col-span-1 sm:row-auto"
                      >
                        <span
                          className={cn(
                            "block h-full rounded-sm",
                            active?.key === group.key ? "bg-primary" : "bg-primary/45",
                          )}
                          style={{
                            width: `${maximum === 0 || value === null ? 0 : (value / maximum) * 100}%`,
                          }}
                        />
                      </span>
                      <span className="col-start-2 row-start-1 text-right tabular-nums sm:col-auto sm:row-auto">
                        {displayValue(value)}
                        {metric === "value" && group.incomplete && value !== null ? (
                          <span className="block text-[10px] text-muted-foreground">subtotal</span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {dimension !== "time" && groups.length > PAGE_SIZE ? (
              <Pagination
                page={currentPage}
                count={groups.length}
                label="comparison groups"
                onChange={(next) => {
                  setPage(next);
                  setSelected(null);
                }}
              />
            ) : null}
          </div>
          {active ? (
            <div className="min-w-0 space-y-3 border-l-2 border-primary/40 pl-4" aria-live="polite">
              <p className="break-words text-sm font-medium">{active.label}</p>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Direct tokens</dt>
                  <dd className="tabular-nums">{integer(totalTokens(active.tokens))}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Occurrences</dt>
                  <dd className="tabular-nums">{integer(active.occurrences)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">
                    {active.incomplete && active.value !== null
                      ? "Priced subtotal"
                      : "API-equivalent estimate"}
                  </dt>
                  <dd className="tabular-nums">{money(active.value)}</dd>
                </div>
              </dl>
              {active.incomplete ? (
                <p className="text-[11px] text-muted-foreground">
                  Pricing is incomplete for this group.
                </p>
              ) : null}
              <TokenBreakdown tokens={active.tokens} />
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function Pagination({
  page,
  count,
  label,
  onChange,
}: {
  readonly page: number;
  readonly count: number;
  readonly label: string;
  readonly onChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 pt-2 text-xs text-muted-foreground">
      <span aria-live="polite">
        {integer(page * PAGE_SIZE + 1)} to {integer(Math.min((page + 1) * PAGE_SIZE, count))} of{" "}
        {integer(count)} {label}
      </span>
      <div className="flex gap-1">
        <Button
          size="icon-sm"
          className="min-h-11 min-w-11"
          variant="ghost"
          aria-label={`Previous ${label}`}
          disabled={page === 0}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          size="icon-sm"
          className="min-h-11 min-w-11"
          variant="ghost"
          aria-label={`Next ${label}`}
          disabled={(page + 1) * PAGE_SIZE >= count}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  );
}

function PayloadRow({
  item,
  value,
  tokens,
}: {
  readonly item: PayloadItem;
  readonly value: number | null;
  readonly tokens: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const catalogItem = "observed" in item ? item : null;
  const unobserved = catalogItem?.observed === false;
  const incomplete =
    catalogItem?.priceStatus === "unpriced" ||
    item.modelCosts.some(
      (model) => model.priceStatus === "unpriced" || model.estimatedApiCostUsd === null,
    );
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${catalogItem ? "Catalog details" : "Details"} for ${item.displayName}`}
        onClick={() => setExpanded(!expanded)}
        className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-3 py-3 text-left hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-[minmax(0,1fr)_5rem_6rem_6rem_1rem]"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{item.displayName}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {SOURCE_LABELS[item.sourceKind]} ·{" "}
            {catalogItem
              ? catalogItem.observed
                ? "Observed · "
                : "Not observed in this period · "
              : null}
            {item.confidence === null ? "No evidence" : CONFIDENCE_LABELS[item.confidence]} ·{" "}
            <span>{(catalogItem?.fileRevisionHash ?? item.contentHash).slice(0, 12)}</span>
          </span>
          {catalogItem ? (
            <span className="mt-1 block text-[11px] tabular-nums text-muted-foreground">
              {catalogItem.byteLength === null
                ? "Unknown file size"
                : `${integer(catalogItem.byteLength)} bytes`}
              {" · "}
              {catalogItem.tokenCount === null
                ? "Unknown token size"
                : `${formatTokens(catalogItem.tokenCount)} content tokens`}
            </span>
          ) : null}
          <span className="mt-1 block text-xs tabular-nums text-muted-foreground sm:hidden">
            {integer(item.occurrences)} occurrences
            {unobserved ? "" : ` · ${formatTokens(tokens)} direct tokens`}
          </span>
        </span>
        <span className="hidden text-right text-xs tabular-nums text-muted-foreground sm:block">
          {integer(item.occurrences)}
          <span className="sr-only"> occurrences</span>
        </span>
        <span className="hidden text-right text-xs tabular-nums sm:block">
          {unobserved ? "Not observed" : formatTokens(tokens)}
          {unobserved ? null : <span className="sr-only"> direct tokens</span>}
        </span>
        <span className="text-right text-xs tabular-nums">
          {money(value)}
          {incomplete && value !== null ? (
            <span className="block text-[10px] text-muted-foreground">subtotal</span>
          ) : null}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3.5 justify-self-end text-muted-foreground",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div className="mb-3 space-y-4 rounded-md bg-muted/30 p-3 text-xs">
          <h4 className="break-words text-sm font-medium">{item.displayName}</h4>
          <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-muted-foreground">Stable content hash</dt>
              <dd className="break-all font-mono">{item.contentHash}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">File revision/hash</dt>
              <dd className="break-all font-mono">{item.fileRevisionHash ?? "Unknown"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">First observed</dt>
              <dd>
                {item.firstObservedAt === null
                  ? "Never observed in this period"
                  : new Date(item.firstObservedAt).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last observed</dt>
              <dd>
                {item.lastObservedAt === null
                  ? "Never observed in this period"
                  : new Date(item.lastObservedAt).toLocaleString()}
              </dd>
            </div>
            {catalogItem ? (
              <>
                <div>
                  <dt className="text-muted-foreground">Current revision size</dt>
                  <dd className="tabular-nums">
                    {catalogItem.byteLength === null
                      ? "Unknown bytes"
                      : `${integer(catalogItem.byteLength)} bytes`}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Content token count</dt>
                  <dd className="tabular-nums">
                    {catalogItem.tokenCount === null ? "Unknown" : integer(catalogItem.tokenCount)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Observation status</dt>
                  <dd>
                    {catalogItem.observed
                      ? "Observed in this period"
                      : "Not observed in this period"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Price state</dt>
                  <dd>
                    {catalogItem.priceStatus === "unpriced"
                      ? "Unpriced"
                      : catalogItem.priceStatus === "providerReported"
                        ? "Provider reported"
                        : "Estimated"}
                  </dd>
                </div>
              </>
            ) : null}
            <div>
              <dt className="text-muted-foreground">
                Occurrences / affected sessions / affected turns
              </dt>
              <dd className="tabular-nums">
                {integer(item.occurrences)} / {integer(item.affectedSessions)} /{" "}
                {integer(item.affectedTurns)}
              </dd>
            </div>
          </dl>
          <div className="space-y-2">
            <h4 className="font-medium">Direct payload input tokens</h4>
            {unobserved ? (
              <p className="text-muted-foreground">
                No direct input was observed. File token size does not establish input usage.
              </p>
            ) : (
              <TokenBreakdown tokens={item.directTokens} />
            )}
          </div>
          <div className="space-y-2">
            <h4 className="font-medium">Observation confidence</h4>
            {item.confidence === null ? (
              <p className="text-muted-foreground">No observation evidence in this period.</p>
            ) : (
              <ConfidenceBreakdown counts={item.confidenceCounts} />
            )}
          </div>
          <div className="space-y-2">
            <h4 className="font-medium">Estimated API-equivalent value by model</h4>
            {item.modelCosts.length === 0 ? (
              <p className="text-muted-foreground">
                {unobserved ? "Unpriced. No observed model input to price." : "Unpriced"}
              </p>
            ) : (
              <div className="max-h-48 overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 font-normal">Model</th>
                      <th className="text-right font-normal">Direct tokens</th>
                      <th className="text-right font-normal">Estimate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.modelCosts.map((model) => (
                      <tr key={model.model}>
                        <td className="break-all py-1 pr-2">{model.model}</td>
                        <td className="text-right tabular-nums">
                          {integer(totalTokens(model.directTokens))}
                        </td>
                        <td className="text-right tabular-nums">
                          {money(model.estimatedApiCostUsd)}
                          {model.priceStatus === "unpriced" && model.estimatedApiCostUsd !== null
                            ? " subtotal"
                            : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <h4 className="font-medium">Project/environment</h4>
            <div className="max-h-32 space-y-1 overflow-auto text-muted-foreground">
              {[...new Set(item.breakdowns.map(projectLabel))].map((label) => (
                <p key={label} className="break-all">
                  {label}
                </p>
              ))}
              {item.breakdowns.length === 0 ? "Unknown" : null}
            </div>
          </div>
          {!unobserved ? (
            <div className="border-t border-border pt-3">
              <p>
                Full affected session input{" "}
                <span className="ml-2 tabular-nums">
                  {integer(totalTokens(item.fullSessionInputTokens))}
                </span>
              </p>
              <p className="mt-1 text-muted-foreground">
                Context for this payload only. Sessions can contain several payloads, so their input
                totals overlap and do not represent payload cost.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Payloads({
  items,
  catalog = false,
}: {
  readonly items: readonly PayloadItem[];
  readonly catalog?: boolean;
}) {
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase());
  const [source, setSource] = useState("all");
  const [confidence, setConfidence] = useState("all");
  const [observed, setObserved] = useState("all");
  const [sort, setSort] = useState(catalog ? "name" : "tokens");
  const [page, setPage] = useState(0);
  const indexed = useMemo(
    () =>
      items.map((item) => ({
        item,
        value: "observed" in item ? item.estimatedApiCostUsd : payloadValue(item),
        tokens: totalTokens(item.directTokens),
        search: [
          item.displayName,
          item.contentHash,
          item.fileRevisionHash ?? "",
          ...item.modelCosts.map((model) => model.model),
          ...item.breakdowns.map(projectLabel),
        ]
          .join("\n")
          .toLowerCase(),
      })),
    [items],
  );
  const filtered = useMemo(
    () =>
      indexed
        .filter(
          ({ item, search: text }) =>
            (source === "all" || item.sourceKind === source) &&
            (observed === "all" ||
              ("observed" in item && item.observed === (observed === "observed"))) &&
            (confidence === "all" ||
              item.confidenceCounts[confidence as keyof typeof item.confidenceCounts] > 0) &&
            (query === "" || text.includes(query)),
        )
        .sort((a, b) =>
          sort === "name"
            ? a.item.displayName.localeCompare(b.item.displayName) ||
              a.item.contentHash.localeCompare(b.item.contentHash) ||
              (a.item.fileRevisionHash ?? "").localeCompare(b.item.fileRevisionHash ?? "")
            : sort === "recent"
              ? (b.item.lastObservedAt ?? "").localeCompare(a.item.lastObservedAt ?? "")
              : sort === "occurrences"
                ? b.item.occurrences - a.item.occurrences
                : sort === "value"
                  ? (b.value ?? -1) - (a.value ?? -1)
                  : b.tokens - a.tokens,
        ),
    [indexed, source, confidence, observed, query, sort],
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const hasFilters =
    search !== "" || source !== "all" || confidence !== "all" || observed !== "all";
  const headingId = catalog ? "repeated-input-catalog-heading" : "repeated-input-payloads-heading";
  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4 border-t border-border pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-medium">
          {catalog ? "Current skill catalog" : "Tracked payloads"}{" "}
          <span className="ml-1 text-xs font-normal tabular-nums text-muted-foreground">
            {integer(items.length)}
          </span>
        </h2>
        <span className="text-[11px] text-muted-foreground">
          {catalog
            ? "Includes revisions with no observation"
            : "Select a payload for evidence and session context"}
        </span>
      </div>
      {catalog ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Currently discoverable skill revisions. Counts and evidence cover the selected period.
          Older observed revisions remain in Tracked payloads below.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <label className="flex min-h-11 min-w-0 basis-full items-center gap-2 rounded-md border border-border px-3 focus-within:outline-2 focus-within:outline-ring lg:flex-1 lg:basis-auto">
          <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            aria-label={catalog ? "Search skill catalog" : "Search repeated payloads"}
            placeholder={
              catalog
                ? "Find a skill, revision, model, or hash"
                : "Find a payload, model, project, or hash"
            }
            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </label>
        {catalog ? (
          <select
            aria-label="Skill observation status"
            className={SELECT_CLASS}
            value={observed}
            onChange={(event) => {
              setObserved(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">All revisions</option>
            <option value="observed">Observed</option>
            <option value="unobserved">Not observed</option>
          </select>
        ) : (
          <select
            aria-label="Payload source kind"
            className={SELECT_CLASS}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">All sources</option>
            {Object.entries(SOURCE_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label={catalog ? "Skill catalog evidence" : "Payload evidence"}
          className={SELECT_CLASS}
          value={confidence}
          onChange={(event) => {
            setConfidence(event.target.value);
            setPage(0);
          }}
        >
          <option value="all">All evidence</option>
          {Object.entries(CONFIDENCE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label={catalog ? "Sort skill catalog" : "Sort repeated payloads"}
          className={SELECT_CLASS}
          value={sort}
          onChange={(event) => {
            setSort(event.target.value);
            setPage(0);
          }}
        >
          {catalog ? <option value="name">Name</option> : null}
          <option value="tokens">Most direct tokens</option>
          <option value="value">Highest estimate</option>
          <option value="occurrences">Most occurrences</option>
          <option value="recent">Most recent</option>
        </select>
        {hasFilters ? (
          <Button
            size="compact"
            className="min-h-11"
            variant="ghost"
            onClick={() => {
              setSearch("");
              setSource("all");
              setConfidence("all");
              setObserved("all");
              setPage(0);
            }}
          >
            {catalog ? "Clear catalog filters" : "Clear filters"}
          </Button>
        ) : null}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Filters apply to complete tracked items. Evidence filters include any matching observation;
        totals and charts keep the full selected window.
      </p>
      <div>
        <div className="hidden grid-cols-[minmax(0,1fr)_5rem_6rem_6rem_1rem] gap-3 border-b border-border pb-2 text-right text-[11px] text-muted-foreground sm:grid">
          <span className="text-left">
            {catalog
              ? "Skill / evidence / revision size"
              : "Payload / strongest evidence / revision"}
          </span>
          <span>Occurrences</span>
          <span>Direct tokens</span>
          <span>API estimate</span>
          <span />
        </div>
        {filtered
          .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
          .map(({ item, value, tokens }) => (
            <PayloadRow
              key={`${item.sourceKind}:${item.contentHash}:${item.fileRevisionHash ?? ""}`}
              item={item}
              value={value}
              tokens={tokens}
            />
          ))}
        {filtered.length === 0 ? (
          <p className="py-5 text-sm text-muted-foreground">
            {catalog
              ? items.length === 0
                ? "No current skill revisions were reported."
                : "No skill revisions match these filters."
              : "No payloads match these filters."}
          </p>
        ) : (
          <Pagination
            page={currentPage}
            count={filtered.length}
            label={catalog ? "skill revisions" : "payloads"}
            onChange={setPage}
          />
        )}
      </div>
    </section>
  );
}

export function RepeatedInputSection({
  data,
}: {
  readonly data?: RepeatedInputSectionData | null;
}) {
  const totals = useMemo(() => {
    let tokens = emptyTokens();
    let occurrences = 0;
    const confidence = { reference: 0, likelyRead: 0, confirmedPayload: 0 };
    for (const item of data?.items ?? []) {
      tokens = addTokens(tokens, item.directTokens);
      occurrences += item.occurrences;
      confidence.reference += item.confidenceCounts.reference;
      confidence.likelyRead += item.confidenceCounts.likelyRead;
      confidence.confirmedPayload += item.confidenceCounts.confirmedPayload;
    }
    return { tokens, occurrences, confidence };
  }, [data]);
  if (data == null) return null;
  const unknown = data.coverageGaps
    .filter((gap) => gap.reason === "unattributed")
    .reduce((total, gap) => total + gap.count, 0);
  return (
    <section aria-labelledby="repeated-input-heading" className="flex min-w-0 flex-col gap-6">
      <div>
        <h2 id="repeated-input-heading" className="text-base font-medium">
          Attribution overview
        </h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Skills, instructions, developer blocks, and tool payloads observed in this period. Only
          metadata and token attribution are shown.
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 rounded-lg border border-border bg-muted/15 p-4 sm:p-5 lg:grid-cols-[1.1fr_1.1fr_0.7fr_0.7fr]">
        {[
          ["Direct payload input", formatTokens(totalTokens(totals.tokens))],
          [
            data.priceStatus === "unpriced" && data.estimatedApiCostUsd !== null
              ? "API-equivalent priced subtotal"
              : "Estimated API-equivalent value",
            money(data.estimatedApiCostUsd),
          ],
          ["Occurrences", integer(totals.occurrences)],
          ["Tracked items", integer(data.items.length)],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-2 break-words text-2xl font-medium tabular-nums tracking-tight sm:text-3xl">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        API-equivalent values estimate direct payload input. Unknown models and missing prices stay
        unpriced. These estimates do not measure subscription usage or charges.
        {data.priceStatus === "unpriced" && data.estimatedApiCostUsd !== null
          ? " Pricing is incomplete; the subtotal includes only priced input."
          : ""}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-xs font-medium">Direct token attribution</h3>
          <TokenBreakdown tokens={totals.tokens} />
        </div>
        <div className="space-y-2">
          <h3 className="text-xs font-medium">Observation confidence</h3>
          <ConfidenceBreakdown counts={totals.confidence} />
          <p className="text-[11px] text-muted-foreground">
            A reference alone does not confirm the payload was sent.
          </p>
        </div>
      </div>
      {data.coverageGaps.length > 0 ? (
        <details className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-ring">
            Coverage and unknown-attribution gaps{" "}
            <span className="ml-1 font-normal text-muted-foreground">
              {integer(data.coverageGaps.length)} gap categories
            </span>
          </summary>
          <div className="mt-2 space-y-1 text-muted-foreground">
            {unknown > 0 ? (
              <p>
                {integer(unknown)} unresolved attribution units could not be assigned to one
                repeated payload.
              </p>
            ) : null}
            {data.coverageGaps.map((gap) => (
              <p key={`${gap.reason}:${gap.message}`}>
                {gap.message} <span className="tabular-nums">{integer(gap.count)}</span>
              </p>
            ))}
          </div>
        </details>
      ) : null}
      {data.catalog ? (
        <Payloads items={data.catalog} catalog />
      ) : (
        <p className="text-xs text-muted-foreground">
          The selected computers did not return a current skill catalog. Observed payload history is
          still available below.
        </p>
      )}
      {data.items.length > 0 ? (
        <>
          <Comparison data={data} />
          <Payloads items={data.items} />
        </>
      ) : (
        <p className="py-3 text-sm text-muted-foreground">
          No repeated payload was confirmed in this window.
        </p>
      )}
    </section>
  );
}
