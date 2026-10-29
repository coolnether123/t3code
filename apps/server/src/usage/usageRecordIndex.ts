/**
 * One transcript's usage, priced once and grouped by bucket dimensions with
 * sorted timestamps and prefix sums. Keys shared across transcripts stay as
 * per-record entries so copied events still count once. Pure: no fs or clock.
 * @module usageRecordIndex
 */
import type { UsageTokenTotals, UsageCategoryCost } from "@t3tools/contracts";

import type { PricedUsage } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

/** A record together with the prices it had when its transcript was indexed. */
export interface PricedRecord {
  readonly record: UsageRecord;
  readonly costUsd: number;
  readonly costSource: PricedUsage["costSource"];
  readonly cacheSavingsUsd: number;
  readonly categoryCostUsd?: UsageCategoryCost | null;
  readonly fastCostUsd?: number;
  readonly ultrafastCostUsd?: number;
  readonly speedPremiumUsd?: number;
}

/** Prefix-sum columns, in this order, `INDEX_FIELDS` values per position. */
export const INDEX_FIELDS = 16;
const UNCACHED = 0;
const CACHED = 1;
const CREATION = 2;
const OUTPUT = 3;
const REASONING = 4;
const COST = 5;
const SAVINGS = 6;
const UNPRICED = 7;
const PROVIDER_REPORTED = 8;

/** Records that share every bucket dimension, sorted by time. */
export interface IndexedGroup {
  readonly provider: UsageRecord["provider"];
  readonly model: string;
  readonly sourcePath?: string;
  readonly sessionId: string;
  readonly nativeSessionId?: string;
  readonly turnId?: string;
  readonly serviceTier?: string;
  readonly serviceTierSource?: NonNullable<UsageRecord["serviceTierSource"]>;
  readonly timestamps: Float64Array;
  /** `(timestamps.length + 1) * INDEX_FIELDS` running totals; row 0 is zero. */
  readonly sums: Float64Array;
}

export interface TranscriptUsageIndex {
  readonly groups: readonly IndexedGroup[];
  /** Records whose de-duplication key is also held by another transcript. */
  readonly shared: readonly PricedRecord[];
  readonly recordCount: number;
  readonly latestMs: number;
  /** One hash per keyed record, for the cross-transcript key registry. */
  readonly keyHashes: readonly number[];
}

/**
 * A 52-bit FNV-1a pair. A collision only marks a key as shared, which sends its
 * records down the exact per-record path, so it can never change a total.
 */
export function hashDedupeKey(key: string): number {
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    high = Math.imul(high ^ code, 0x01000193);
    low = Math.imul(low ^ code, 0x5bd1e995);
  }
  return (high >>> 0) * 0x100000 + ((low >>> 0) & 0xfffff);
}

/** Index of the first timestamp at or after `timeMs`. */
export function lowerBound(timestamps: Float64Array, timeMs: number): number {
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timestamps[middle]! < timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Sums of one group's records in positions `[start, end)`. */
export interface GroupRange {
  readonly totals: UsageTokenTotals;
  readonly categoryCostUsd: UsageCategoryCost | null;
  readonly fastCostUsd: number;
  readonly ultrafastCostUsd: number;
  readonly speedPremiumUsd: number;
  readonly costUsd: number;
  readonly cacheSavingsUsd: number;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly providerReportedRecords: number;
  readonly firstMs: number;
  readonly lastMs: number;
}

export function readGroupRange(group: IndexedGroup, start: number, end: number): GroupRange {
  const sums = group.sums;
  const from = start * INDEX_FIELDS;
  const to = end * INDEX_FIELDS;
  const column = (field: number) => sums[to + field]! - sums[from + field]!;
  return {
    totals: {
      uncachedInputTokens: column(UNCACHED),
      cachedInputTokens: column(CACHED),
      cacheCreationTokens: column(CREATION),
      outputTokens: column(OUTPUT),
      reasoningTokens: column(REASONING),
    },
    categoryCostUsd: {
      input: column(9),
      cacheRead: column(10),
      cacheWrite: column(11),
      output: column(12),
    },
    fastCostUsd: column(13),
    ultrafastCostUsd: column(14),
    speedPremiumUsd: column(15),
    costUsd: column(COST),
    cacheSavingsUsd: column(SAVINGS),
    records: end - start,
    unpricedRecords: column(UNPRICED),
    providerReportedRecords: column(PROVIDER_REPORTED),
    firstMs: group.timestamps[start]!,
    lastMs: group.timestamps[end - 1]!,
  };
}

const groupKey = (record: UsageRecord) =>
  [
    record.provider,
    record.sourcePath ?? "",
    record.model,
    record.sessionId,
    record.nativeSessionId ?? "",
    record.turnId ?? "\u0001",
    record.serviceTier ?? "\u0001",
    record.serviceTierSource ?? "\u0001",
  ].join("\u0000");

/**
 * Builds the index for one transcript's records.
 *
 * `price` sees each record exactly once and returns it with any tier correction
 * applied. `isShared` says whether a key hash is held by another transcript; a
 * key repeated inside this transcript is treated the same way.
 */
export function buildTranscriptUsageIndex(
  records: readonly UsageRecord[],
  price: (record: UsageRecord) => PricedRecord,
  isShared: (keyHash: number) => boolean,
): TranscriptUsageIndex {
  const byGroup = new Map<string, PricedRecord[]>();
  const shared: PricedRecord[] = [];
  const keyHashes = records.map((record) =>
    record.dedupeKey === null ? null : hashDedupeKey(record.dedupeKey),
  );
  const repeated = new Set<number>();
  const seen = new Set<number>();
  for (const keyHash of keyHashes) {
    if (keyHash === null) continue;
    if (seen.has(keyHash)) repeated.add(keyHash);
    seen.add(keyHash);
  }
  let latestMs = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < records.length; index++) {
    const priced = price(records[index]!);
    latestMs = Math.max(latestMs, priced.record.timestampMs);
    const keyHash = keyHashes[index];
    if (keyHash !== null && keyHash !== undefined && (repeated.has(keyHash) || isShared(keyHash))) {
      shared.push(priced);
      continue;
    }
    const key = groupKey(priced.record);
    let members = byGroup.get(key);
    if (members === undefined) {
      members = [];
      byGroup.set(key, members);
    }
    members.push(priced);
  }

  const groups: IndexedGroup[] = [];
  for (const members of byGroup.values()) {
    members.sort((a, b) => a.record.timestampMs - b.record.timestampMs);
    const first = members[0]!.record;
    const timestamps = new Float64Array(members.length);
    const sums = new Float64Array((members.length + 1) * INDEX_FIELDS);
    for (let index = 0; index < members.length; index++) {
      const { record, costUsd, costSource, cacheSavingsUsd } = members[index]!;
      const priced = members[index]!;
      timestamps[index] = record.timestampMs;
      const previous = index * INDEX_FIELDS;
      const next = previous + INDEX_FIELDS;
      const extra = [
        priced.categoryCostUsd?.input ?? 0,
        priced.categoryCostUsd?.cacheRead ?? 0,
        priced.categoryCostUsd?.cacheWrite ?? 0,
        priced.categoryCostUsd?.output ?? 0,
        priced.fastCostUsd ?? 0,
        priced.ultrafastCostUsd ?? 0,
        priced.speedPremiumUsd ?? 0,
      ];
      extra.forEach((value, field) => {
        sums[next + 9 + field] = sums[previous + 9 + field]! + value;
      });
      sums[next + UNCACHED] = sums[previous + UNCACHED]! + record.totals.uncachedInputTokens;
      sums[next + CACHED] = sums[previous + CACHED]! + record.totals.cachedInputTokens;
      sums[next + CREATION] = sums[previous + CREATION]! + record.totals.cacheCreationTokens;
      sums[next + OUTPUT] = sums[previous + OUTPUT]! + record.totals.outputTokens;
      sums[next + REASONING] = sums[previous + REASONING]! + record.totals.reasoningTokens;
      sums[next + COST] = sums[previous + COST]! + costUsd;
      sums[next + SAVINGS] = sums[previous + SAVINGS]! + cacheSavingsUsd;
      sums[next + UNPRICED] = sums[previous + UNPRICED]! + (costSource === "unpriced" ? 1 : 0);
      sums[next + PROVIDER_REPORTED] =
        sums[previous + PROVIDER_REPORTED]! + (costSource === "providerReported" ? 1 : 0);
    }
    groups.push({
      provider: first.provider,
      ...(first.sourcePath === undefined ? {} : { sourcePath: first.sourcePath }),
      model: first.model,
      sessionId: first.sessionId,
      ...(first.nativeSessionId === undefined ? {} : { nativeSessionId: first.nativeSessionId }),
      ...(first.turnId === undefined ? {} : { turnId: first.turnId }),
      ...(first.serviceTier === undefined ? {} : { serviceTier: first.serviceTier }),
      ...(first.serviceTierSource === undefined
        ? {}
        : { serviceTierSource: first.serviceTierSource }),
      timestamps,
      sums,
    });
  }
  return {
    groups,
    shared,
    recordCount: records.length,
    latestMs,
    keyHashes: [...seen],
  };
}

/**
 * Which de-duplication keys more than one transcript holds. A key gaining its
 * second holder forces the first holder's index to rebuild (`register` reports
 * it); a key back to one holder stays per-record until that holder rebuilds.
 */
export class DedupeKeyRegistry {
  readonly #holders = new Map<number, number>();
  readonly #soleHolder = new Map<number, string>();
  readonly #byPath = new Map<string, readonly number[]>();

  isShared(keyHash: number, path: string): boolean {
    const holders = this.#holders.get(keyHash) ?? 0;
    if (holders === 0) return false;
    return holders > 1 || this.#soleHolder.get(keyHash) !== path;
  }

  /** Replaces `path`'s keys and returns the transcripts whose indexes went stale. */
  register(path: string, keyHashes: readonly number[]): ReadonlySet<string> {
    this.remove(path);
    const unique = [...new Set(keyHashes)];
    const stale = new Set<string>();
    for (const keyHash of unique) {
      const holders = this.#holders.get(keyHash) ?? 0;
      if (holders === 1) {
        const sole = this.#soleHolder.get(keyHash);
        if (sole !== undefined && sole !== path) stale.add(sole);
        this.#soleHolder.delete(keyHash);
      } else if (holders === 0) {
        this.#soleHolder.set(keyHash, path);
      }
      this.#holders.set(keyHash, holders + 1);
    }
    this.#byPath.set(path, unique);
    return stale;
  }

  remove(path: string): void {
    const previous = this.#byPath.get(path);
    if (previous === undefined) return;
    this.#byPath.delete(path);
    for (const keyHash of previous) {
      const holders = (this.#holders.get(keyHash) ?? 1) - 1;
      if (holders <= 0) {
        this.#holders.delete(keyHash);
        this.#soleHolder.delete(keyHash);
      } else {
        this.#holders.set(keyHash, holders);
        if (this.#soleHolder.get(keyHash) === path) this.#soleHolder.delete(keyHash);
      }
    }
  }

  clear(): void {
    this.#holders.clear();
    this.#soleHolder.clear();
    this.#byPath.clear();
  }
}
