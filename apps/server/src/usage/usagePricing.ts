/**
 * Model rate lookup and cost arithmetic.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json`, the same
 * table `ccusage` prices against. Everything here is pure: fetching and caching
 * the table lives in `UsageService`.
 *
 * @module usagePricing
 */
import type { UsageCostSource, UsageTokenTotals } from "@t3tools/contracts";

/**
 * The subset of a LiteLLM entry we price against. All values are USD per token.
 *
 * Context-length tiers use each request's input count. Service tiers default to
 * standard rates; transcript token totals don't identify fast/flex/batch billing.
 */
export interface ModelRate {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number | null;
  readonly cacheCreationCostPerToken: number | null;
  readonly above200kTokens?: ModelRate;
  readonly above272kTokens?: ModelRate;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/** Raw shape of one LiteLLM entry, narrowed to the fields we read. */
interface LiteLlmEntry {
  readonly input_cost_per_token?: unknown;
  readonly output_cost_per_token?: unknown;
  readonly cache_read_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost?: unknown;
  readonly input_cost_per_token_cache_hit?: unknown;
  readonly input_cost_per_token_above_200k_tokens?: unknown;
  readonly output_cost_per_token_above_200k_tokens?: unknown;
  readonly cache_read_input_token_cost_above_200k_tokens?: unknown;
  readonly cache_creation_input_token_cost_above_200k_tokens?: unknown;
  readonly input_cost_per_token_above_272k_tokens?: unknown;
  readonly output_cost_per_token_above_272k_tokens?: unknown;
  readonly cache_read_input_token_cost_above_272k_tokens?: unknown;
  readonly cache_creation_input_token_cost_above_272k_tokens?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Projects the LiteLLM document into a rate table.
 *
 * Entries without both an input and an output rate are dropped: a half-priced
 * model would silently under-report cost, which is worse than reporting the
 * model as unpriced.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const input = finiteNumber(entry.input_cost_per_token);
    const output = finiteNumber(entry.output_cost_per_token);
    if (input === null || output === null) continue;

    const aboveInput = finiteNumber(entry.input_cost_per_token_above_272k_tokens);
    const aboveOutput = finiteNumber(entry.output_cost_per_token_above_272k_tokens);
    const above200Input = finiteNumber(entry.input_cost_per_token_above_200k_tokens);
    const above200Output = finiteNumber(entry.output_cost_per_token_above_200k_tokens);
    table.set(normalizeModelName(name), {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken:
        finiteNumber(entry.cache_read_input_token_cost) ??
        finiteNumber(entry.input_cost_per_token_cache_hit),
      cacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost),
      ...(above200Input !== null && above200Output !== null
        ? {
            above200kTokens: {
              inputCostPerToken: above200Input,
              outputCostPerToken: above200Output,
              cacheReadCostPerToken: finiteNumber(
                entry.cache_read_input_token_cost_above_200k_tokens,
              ),
              cacheCreationCostPerToken: finiteNumber(
                entry.cache_creation_input_token_cost_above_200k_tokens,
              ),
            },
          }
        : {}),
      ...(aboveInput !== null && aboveOutput !== null
        ? {
            above272kTokens: {
              inputCostPerToken: aboveInput,
              outputCostPerToken: aboveOutput,
              cacheReadCostPerToken: finiteNumber(
                entry.cache_read_input_token_cost_above_272k_tokens,
              ),
              cacheCreationCostPerToken: finiteNumber(
                entry.cache_creation_input_token_cost_above_272k_tokens,
              ),
            },
          }
        : {}),
    });
  }
  return table;
}

/**
 * Canonicalises a model name for lookup.
 *
 * Retains the provider namespace: resellers can charge different rates for the
 * same underlying model. Only casing and surrounding whitespace are normalized.
 */
export function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * Models we never price, regardless of the table.
 *
 * `<synthetic>` marks locally generated messages that were never billed. Bare
 * family names ("opus", "sonnet") are genuinely ambiguous across generations,
 * so we report them as unpriced instead of guessing a generation.
 */
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const normalized = normalizeModelName(model);
  if (normalized.length === 0 || UNPRICEABLE_MODELS.has(normalized)) return null;
  const exact = table.get(normalized);
  if (exact !== undefined) return exact;
  // First-party transcript spellings may differ from the catalogue's namespace.
  // Never strip arbitrary reseller or local-router prefixes.
  if (/^(openai\/gpt-|anthropic\/claude-)/.test(normalized)) {
    return table.get(normalized.slice(normalized.indexOf("/") + 1)) ?? null;
  }
  if (normalized.startsWith("google/gemini-")) {
    const name = normalized.slice("google/".length);
    return table.get(`gemini/${name}`) ?? table.get(name) ?? null;
  }
  if (normalized.startsWith("gemini-")) return table.get(`gemini/${normalized}`) ?? null;
  return null;
}

export interface PricedUsage {
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
}

function rateForTotals(rate: ModelRate, totals: UsageTokenTotals): ModelRate {
  const inputTokens =
    totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens;
  if (inputTokens > 272_000 && rate.above272kTokens !== undefined) return rate.above272kTokens;
  if (inputTokens > 200_000 && rate.above200kTokens !== undefined) return rate.above200kTokens;
  return rate;
}

/**
 * Prices a bucket's tokens.
 *
 * `reasoningTokens` is intentionally not charged separately: it is already
 * counted inside `outputTokens`.
 */
export function priceUsage(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
  reportedCostUsd: number | null,
): PricedUsage {
  if (reportedCostUsd !== null && finiteNumber(reportedCostUsd) !== null) {
    return { costUsd: reportedCostUsd, costSource: "providerReported" };
  }

  const baseRate = lookupRate(table, model);
  if (baseRate === null) return { costUsd: 0, costSource: "unpriced" };
  const rate = rateForTotals(baseRate, totals);
  if (
    (totals.cachedInputTokens > 0 && rate.cacheReadCostPerToken === null) ||
    (totals.cacheCreationTokens > 0 && rate.cacheCreationCostPerToken === null)
  )
    return { costUsd: 0, costSource: "unpriced" };

  const costUsd =
    totals.uncachedInputTokens * rate.inputCostPerToken +
    totals.cachedInputTokens * (rate.cacheReadCostPerToken ?? 0) +
    totals.cacheCreationTokens * (rate.cacheCreationCostPerToken ?? 0) +
    totals.outputTokens * rate.outputCostPerToken;

  return { costUsd, costSource: "modelPriced" };
}

/**
 * What the cached input would have cost at full input rates, minus what it
 * actually cost. Drives the "cache savings" figure.
 */
export function cacheSavingsUsd(table: RateTable, model: string, totals: UsageTokenTotals): number {
  const baseRate = lookupRate(table, model);
  if (baseRate === null) return 0;
  const rate = rateForTotals(baseRate, totals);
  if (rate.cacheReadCostPerToken === null) return 0;
  return totals.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken);
}
