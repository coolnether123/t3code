import { describe, expect, it } from "@effect/vitest";

import { UsageAggregator, type AggregateOptions } from "./usageAggregation.ts";
import type { RateTable } from "./usagePricing.ts";
import { QuotaCostAccumulator } from "./usageQuotaHistory.ts";
import {
  buildTranscriptUsageIndex,
  DedupeKeyRegistry,
  hashDedupeKey,
  type TranscriptUsageIndex,
} from "./usageRecordIndex.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const rates: RateTable = new Map([
  [
    "claude-fable-5",
    {
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
    },
  ],
  [
    "gpt-long-context",
    {
      inputCostPerToken: 1e-6,
      outputCostPerToken: 2e-6,
      cacheReadCostPerToken: 0.1e-6,
      cacheCreationCostPerToken: 1.25e-6,
      above272kTokens: {
        inputCostPerToken: 2e-6,
        outputCostPerToken: 3e-6,
        cacheReadCostPerToken: 0.2e-6,
        cacheCreationCostPerToken: 2.5e-6,
      },
    },
  ],
]);

/** Deterministic, so a failure reproduces. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const startMs = Date.parse("2026-08-05T18:20:00Z");

/** Transcripts with forked copies, in-file repeats, unpriced models and long contexts. */
function transcripts(seed: number): UsageRecord[][] {
  const next = random(seed);
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  const files: UsageRecord[][] = [];
  for (let file = 0; file < 14; file++) {
    const provider = file % 3 === 0 ? "claude" : "codex";
    const sessionId = file % 5 === 4 ? "" : `session-${file % 9}`;
    const records: UsageRecord[] = [];
    const count = 5 + Math.floor(next() * 60);
    for (let index = 0; index < count; index++) {
      const longContext = next() < 0.15;
      const tier =
        provider === "codex" ? pick([undefined, undefined, "priority", "flex"]) : undefined;
      const turnId = next() < 0.8 ? `turn-${Math.floor(next() * 4)}` : undefined;
      const record: UsageRecord = {
        provider,
        timestampMs: startMs + Math.floor(next() * 3.2 * 24 * 60 * 60 * 1000),
        model:
          provider === "claude"
            ? pick(["claude-fable-5", "claude-fable-5", "unknown-model"])
            : pick(["gpt-long-context", "gpt-long-context", "unknown-model"]),
        sessionId,
        ...(next() < 0.7 ? { nativeSessionId: `run-${file % 6}` } : {}),
        ...(turnId === undefined ? {} : { turnId }),
        ...(tier === undefined
          ? {}
          : { serviceTier: tier, serviceTierSource: "transcript" as const }),
        totals: {
          uncachedInputTokens: longContext ? 280_000 : Math.floor(next() * 5_000),
          cachedInputTokens: Math.floor(next() * 50_000),
          cacheCreationTokens: Math.floor(next() * 500),
          outputTokens: Math.floor(next() * 3_000),
          reasoningTokens: Math.floor(next() * 300),
        },
        reportedCostUsd: provider === "claude" && next() < 0.2 ? next() / 10 : null,
        dedupeKey: next() < 0.15 ? null : `key-${file}-${index}`,
      };
      records.push(record);
      if (next() < 0.03) records.push({ ...record });
    }
    files.push(records);
  }
  // Forks copy earlier events forward under another session; the same Codex
  // event also exists in a second home with its original session.
  for (let copy = 0; copy < 40; copy++) {
    const from = files[Math.floor(next() * files.length)]!;
    const source = from[Math.floor(next() * from.length)]!;
    if (source.dedupeKey === null) continue;
    const into = files[Math.floor(next() * files.length)]!;
    into.splice(Math.floor(next() * into.length), 0, {
      ...source,
      ...(next() < 0.5 ? { sessionId: `fork-${copy % 3}` } : {}),
      ...(next() < 0.3 ? { timestampMs: source.timestampMs + 90_000 } : {}),
    });
  }
  return files;
}

const quotaIntervals = [
  { id: "a", sinceTime: "2026-08-05T20:07:31Z", untilTime: "2026-08-06T11:00:00Z" },
  { id: "b", sinceTime: "2026-08-06T11:00:00Z", untilTime: "2026-08-07T23:59:59Z" },
];

function byRecords(files: readonly UsageRecord[][], options: AggregateOptions) {
  const aggregator = new UsageAggregator(options);
  const quota = new QuotaCostAccumulator(quotaIntervals, rates, undefined, "codex");
  const sessions = new Set<string>();
  for (const records of files) {
    for (const record of records) {
      if (!aggregator.add(record)) continue;
      if (record.sessionId.length > 0) sessions.add(record.sessionId);
      quota.add(record);
    }
  }
  return { result: aggregator.finish(), quota: quota.rows, sessions };
}

function byIndex(files: readonly UsageRecord[][], options: AggregateOptions) {
  const aggregator = new UsageAggregator(options);
  const quota = new QuotaCostAccumulator(quotaIntervals, rates, undefined, "codex");
  const registry = new DedupeKeyRegistry();
  const stale = new Set<string>();
  const indexes: TranscriptUsageIndex[] = [];
  const build = (position: number) => {
    const path = `file-${position}`;
    const index = buildTranscriptUsageIndex(
      files[position]!,
      (record) => aggregator.price(record),
      (keyHash) => registry.isShared(keyHash, path),
    );
    for (const stalePath of registry.register(path, index.keyHashes)) stale.add(stalePath);
    stale.delete(path);
    indexes[position] = index;
  };
  for (let position = 0; position < files.length; position++) build(position);
  for (let position = 0; position < files.length; position++) {
    if (stale.has(`file-${position}`)) build(position);
  }
  expect(stale.size).toBe(0);

  const sessions = new Set<string>();
  const { sinceTimeMs, untilTimeMs } = aggregator.window();
  for (const index of indexes) {
    for (const group of index.groups) {
      if (!aggregator.addGroup(group)) continue;
      if (group.sessionId.length > 0) sessions.add(group.sessionId);
      quota.addGroup(group, sinceTimeMs, untilTimeMs);
    }
    for (const priced of index.shared) {
      if (!aggregator.addPriced(priced)) continue;
      if (priced.record.sessionId.length > 0) sessions.add(priced.record.sessionId);
      quota.addPriced(priced);
    }
  }
  return { result: aggregator.finish(), quota: quota.rows, sessions };
}

/** Sums are added in a different order, so costs agree to rounding only. */
function expectSameUsage(
  actual: ReturnType<typeof byRecords>,
  expected: ReturnType<typeof byRecords>,
) {
  const round = <T extends { costUsd: number }>(value: T) => ({
    ...value,
    costUsd: Math.round(value.costUsd * 1e9),
  });
  // Buckets that tie on day, hour, provider and model keep insertion order.
  const buckets = (result: ReturnType<typeof byRecords>["result"]) =>
    result.buckets
      .map((bucket) =>
        round({ ...bucket, cacheSavingsUsd: Math.round(bucket.cacheSavingsUsd * 1e9) }),
      )
      .sort((a, b) =>
        [a.day, a.hourStart, a.provider, a.model, a.serviceTier, a.sessionId, a.turnId, a.runId]
          .join("|")
          .localeCompare(
            [
              b.day,
              b.hourStart,
              b.provider,
              b.model,
              b.serviceTier,
              b.sessionId,
              b.turnId,
              b.runId,
            ].join("|"),
          ),
      );
  expect(buckets(actual.result)).toEqual(buckets(expected.result));
  expect(actual.result.duplicatesDropped).toBe(expected.result.duplicatesDropped);
  expect(actual.result.outOfWindow).toBe(expected.result.outOfWindow);
  expect([...actual.sessions].sort()).toEqual([...expected.sessions].sort());
  const quota = (rows: ReturnType<typeof byRecords>["quota"]) =>
    rows.map((row) => ({
      ...round(row),
      models: row.models.map(round).sort((a, b) => a.model.localeCompare(b.model)),
    }));
  expect(quota(actual.quota)).toEqual(quota(expected.quota));
}

describe("transcript usage index", () => {
  const windows: { readonly name: string; readonly options: Omit<AggregateOptions, "rates"> }[] =
    [];
  for (const timeZone of ["UTC", "Asia/Kolkata", "America/Chicago"]) {
    windows.push({
      name: `days in ${timeZone}`,
      options: { timeZone, sinceDay: "2026-08-06", untilDay: "2026-08-07" },
    });
    windows.push({
      name: `hours in ${timeZone}`,
      options: {
        timeZone,
        sinceDay: "2026-08-05",
        untilDay: "2026-08-08",
        resolution: "hour",
        sinceTimeMs: Date.parse("2026-08-05T21:13:00Z"),
        untilTimeMs: Date.parse("2026-08-07T20:41:00Z"),
      },
    });
  }
  const shapes: { readonly name: string; readonly options: Partial<AggregateOptions> }[] = [
    { name: "by model", options: {} },
    { name: "by session", options: { groupBy: "session" } },
    { name: "by turn", options: { groupBy: "turn" } },
    { name: "by run", options: { groupBy: "run" } },
    { name: "one session", options: { sessionIds: ["session-1", "fork-2"] } },
    { name: "Codex only", options: { providers: ["codex"] } },
  ];

  for (const window of windows) {
    for (const shape of shapes) {
      it(`matches per-record aggregation for ${window.name}, ${shape.name}`, () => {
        for (const seed of [1, 2, 3, 4]) {
          const files = transcripts(seed);
          const options = { ...window.options, ...shape.options, rates };
          expectSameUsage(byIndex(files, options), byRecords(files, options));
        }
      });
    }
  }

  it("rebuilds the first holder when a second transcript shares its key", () => {
    const registry = new DedupeKeyRegistry();
    const key = hashDedupeKey("codex:session:1");
    expect(registry.register("a", [key]).size).toBe(0);
    expect(registry.isShared(key, "a")).toBe(false);
    expect([...registry.register("b", [key])]).toEqual(["a"]);
    expect(registry.isShared(key, "a")).toBe(true);
    expect(registry.isShared(key, "b")).toBe(true);
    registry.remove("b");
    // The survivor stays on the exact path until its own index is rebuilt.
    expect(registry.isShared(key, "a")).toBe(true);
    expect(registry.register("a", [key]).size).toBe(0);
    expect(registry.isShared(key, "a")).toBe(false);
  });
});
