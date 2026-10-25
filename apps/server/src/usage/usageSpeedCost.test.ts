import { describe, expect, it } from "vite-plus/test";
import { UsageAggregator, resolveModelAliases } from "./usageAggregation.ts";
import { buildTranscriptUsageIndex } from "./usageRecordIndex.ts";
import { createOverrideRateTable, parseRateTable, priceUsageRecord } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const record: UsageRecord = {
  provider: "pi",
  timestampMs: Date.parse("2026-10-19T06:00:00Z"),
  model: "display-model",
  rateModel: "provider/rate-model",
  speed: "fast",
  sessionId: "synthetic-session",
  nativeSessionId: "synthetic-session",
  sourcePath: "/synthetic/pi",
  totals: {
    uncachedInputTokens: 10,
    cachedInputTokens: 5,
    cacheCreationTokens: 2,
    outputTokens: 3,
    reasoningTokens: 1,
  },
  reportedCostUsd: null,
  dedupeKey: "synthetic-record",
};
const rates = parseRateTable({
  "provider/rate-model": {
    input_cost_per_token: 1,
    output_cost_per_token: 2,
    cache_read_input_token_cost: 0.1,
    cache_creation_input_token_cost: 1.25,
    provider_specific_entry: { fast: 3 },
  },
});

describe("provider cost and speed integration", () => {
  it("resolves configured model aliases and leaves cycles unmapped", () => {
    const aliases = resolveModelAliases({
      "display-model": "middle",
      middle: "provider/rate-model",
      cycle: "other",
      other: "cycle",
    });
    expect(aliases.get("display-model")).toBe("provider/rate-model");
    expect(aliases.has("cycle")).toBe(false);
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-10-19",
      untilDay: "2026-10-19",
      rates,
      modelAliases: aliases,
    });
    aggregator.add({ ...record, rateModel: "unpriced-native-rate" });
    expect(aggregator.finish().buckets[0]).toMatchObject({
      model: "provider/rate-model",
      costUsd: 57,
    });
  });
  it("prices the provider rate model and scales token categories to reported cost", () => {
    const priced = priceUsageRecord(rates, record);
    expect(priced.costUsd).toBe(57);
    expect(priced.speedPremiumUsd).toBe(38);
    expect(priced.categoryCostUsd?.cacheRead).toBeCloseTo(1.5, 12);
    expect(priced.categoryCostUsd).toMatchObject({
      input: 30,
      cacheWrite: 7.5,
      output: 18,
    });
    const reported = priceUsageRecord(rates, { ...record, reportedCostUsd: 114 });
    expect(reported.costSource).toBe("providerReported");
    expect(reported.categoryCostUsd?.cacheRead).toBeCloseTo(3, 12);
    expect(reported.categoryCostUsd).toMatchObject({
      input: 60,
      cacheWrite: 15,
      output: 36,
    });
  });
  it("lets an explicit display-model override replace a provider-reported price", () => {
    const overrides = createOverrideRateTable({
      "display-model": {
        inputCostPerMillionTokens: 1_000_000,
        outputCostPerMillionTokens: 2_000_000,
      },
    });
    expect(priceUsageRecord(rates, { ...record, reportedCostUsd: 999 }, overrides).costUsd).toBe(
      23,
    );
  });
  it("retains source paths, category costs and speed premiums through the index", () => {
    const options = { timeZone: "UTC", sinceDay: "2026-10-19", untilDay: "2026-10-19", rates };
    const raw = new UsageAggregator(options);
    raw.add(record);
    const indexed = new UsageAggregator(options);
    const index = buildTranscriptUsageIndex(
      [record],
      (item) => indexed.price(item),
      () => false,
    );
    index.groups.forEach((group) => indexed.addGroup(group));
    expect(indexed.finish()).toEqual(raw.finish());
    expect(indexed.finish().buckets[0]).toMatchObject({
      sourcePath: "/synthetic/pi",
      fastCostUsd: 57,
      speedPremiumUsd: 38,
    });
  });
});
