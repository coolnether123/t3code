// @effect-diagnostics globalDate:off
/**
 * Folds parsed transcript records into `(day, hourStart?, provider, model)`
 * buckets.
 *
 * `Intl.DateTimeFormat` is the only reliable way to resolve a wall-clock day in
 * an arbitrary IANA zone, and it takes a `Date`. That is why the raw `Date`
 * construction is allowed here; nothing in this module reads the clock.
 *
 * Pure, so the bucketing and de-duplication rules are testable without touching
 * the filesystem or the network.
 *
 * @module usageAggregation
 */
import type { UsageBucket, UsageDay, UsageResolution, UsageTokenTotals } from "@t3tools/contracts";

import { addTotals, EMPTY_TOTALS, type UsageRecord } from "./usageTranscripts.ts";
import { cacheSavingsUsd, priceUsage, type RateTable } from "./usagePricing.ts";
import {
  lowerBound,
  readGroupRange,
  type GroupRange,
  type IndexedGroup,
  type PricedRecord,
} from "./usageRecordIndex.ts";

/** The record fields that pick a bucket; shared by raw records and indexed groups. */
type BucketDimensions = Pick<
  UsageRecord,
  | "provider"
  | "model"
  | "sessionId"
  | "nativeSessionId"
  | "turnId"
  | "serviceTier"
  | "serviceTierSource"
>;

function safeRunIdOf(record: BucketDimensions): string {
  return record.nativeSessionId !== undefined &&
    record.nativeSessionId.length > 0 &&
    record.nativeSessionId.length <= 512 &&
    record.nativeSessionId.trim() === record.nativeSessionId
    ? record.nativeSessionId
    : "";
}

/** First instant in `(afterMs, beforeMs]` whose local day is no longer `day`. */
function firstInstantAfterDay(
  toDay: (timestampMs: number) => string,
  day: string,
  afterMs: number,
  beforeMs: number,
): number {
  let low = afterMs + 1;
  let high = beforeMs;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (toDay(middle) === day) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Formats an instant as a `YYYY-MM-DD` day in `timeZone`.
 *
 * `en-CA` yields ISO-ordered parts, which is why it is used here rather than
 * assembling the day from `Date` getters (those are host-local only).
 */
export function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // An unknown zone should degrade to UTC rather than fail the whole scan.
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return (timestampMs) => format.format(new Date(timestampMs));
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface DailyWindowIndex {
  readonly sinceTimeMs: number;
  readonly untilTimeMs: number;
  readonly dayAt: (timestampMs: number) => string | null;
  /** The day holding `timestampMs` and the instant the next one starts. */
  readonly dayRangeAt: (
    timestampMs: number,
  ) => { readonly day: string; readonly endMs: number } | null;
}

function nextIsoDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** Builds exact local-day boundaries once instead of formatting every record. */
function makeDailyWindowIndex(
  toDay: (timestampMs: number) => string,
  sinceDay: string,
  untilDay: string,
): DailyWindowIndex {
  const firstInstantOfDay = (day: string): number => {
    const center = Date.parse(`${day}T00:00:00Z`);
    let low = center - 26 * HOUR_MS;
    let high = center + 26 * HOUR_MS;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (toDay(middle) < day) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  const days: string[] = [];
  const starts: number[] = [];
  for (let day = sinceDay; day <= untilDay; day = nextIsoDay(day)) {
    days.push(day);
    starts.push(firstInstantOfDay(day));
  }
  const untilTimeMs = firstInstantOfDay(nextIsoDay(untilDay));

  const dayIndexAt = (timestampMs: number): number => {
    if (timestampMs < (starts[0] ?? untilTimeMs) || timestampMs >= untilTimeMs) return -1;
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((starts[middle] ?? untilTimeMs) <= timestampMs) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  };
  return {
    sinceTimeMs: starts[0] ?? untilTimeMs,
    untilTimeMs,
    dayAt: (timestampMs) => days[dayIndexAt(timestampMs)] ?? null,
    dayRangeAt: (timestampMs) => {
      const index = dayIndexAt(timestampMs);
      const day = days[index];
      return day === undefined ? null : { day, endMs: starts[index + 1] ?? untilTimeMs };
    },
  };
}

interface MutableBucket {
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  records: number;
  unpricedRecords: number;
  providerReportedRecords: number;
  sessions: Set<string>;
  firstActivityAtMs: number;
  lastActivityAtMs: number;
}

export interface AggregateOptions {
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly rates: RateTable;
  readonly priceOverrides?: RateTable;
  readonly resolution?: UsageResolution;
  readonly sinceTimeMs?: number;
  readonly untilTimeMs?: number;
  readonly providers?: readonly UsageRecord["provider"][];
  readonly sessionIds?: readonly string[];
  readonly runIds?: readonly string[];
  readonly turnIds?: readonly string[];
  readonly groupBy?: "model" | "session" | "turn" | "run";
}

export interface AggregateResult {
  readonly buckets: readonly UsageBucket[];
  /** Records dropped because an earlier record carried the same dedupe key. */
  readonly duplicatesDropped: number;
  /** Records whose day fell outside the requested window. */
  readonly outOfWindow: number;
}

/**
 * Accumulates records across many files.
 *
 * De-duplication is global across the whole scan, not per file: Claude Code
 * copies a message's records forward when a session is resumed or forked, so
 * the same `dedupeKey` legitimately appears in several transcripts.
 */
export class UsageAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #seen = new Set<string>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null;
  readonly #dailyWindow: DailyWindowIndex | null;
  readonly #options: AggregateOptions;
  readonly #providers: ReadonlySet<UsageRecord["provider"]> | null;
  readonly #sessionIds: ReadonlySet<string> | null;
  readonly #runIds: ReadonlySet<string> | null;
  readonly #turnIds: ReadonlySet<string> | null;
  #duplicatesDropped = 0;
  #outOfWindow = 0;

  constructor(options: AggregateOptions) {
    this.#options = options;
    this.#providers = options.providers === undefined ? null : new Set(options.providers);
    this.#sessionIds = options.sessionIds === undefined ? null : new Set(options.sessionIds);
    this.#runIds = options.runIds === undefined ? null : new Set(options.runIds);
    this.#turnIds = options.turnIds === undefined ? null : new Set(options.turnIds);
    this.#toDay = makeDayFormatter(options.timeZone);
    if (options.resolution === "hour") {
      if (options.sinceTimeMs === undefined || options.untilTimeMs === undefined) {
        throw new Error("Hourly usage aggregation requires exact time bounds");
      }
      this.#hourlyWindow = {
        sinceTimeMs: options.sinceTimeMs,
        untilTimeMs: options.untilTimeMs,
      };
      this.#dailyWindow = null;
    } else {
      this.#hourlyWindow = null;
      this.#dailyWindow = makeDailyWindowIndex(this.#toDay, options.sinceDay, options.untilDay);
    }
  }

  /** Prices a record with this aggregation's rates, as `add` does. */
  price(record: UsageRecord): PricedRecord {
    const priced = priceUsage(
      this.#options.rates,
      record.model,
      record.totals,
      record.reportedCostUsd,
      record.serviceTier,
      this.#options.priceOverrides,
    );
    return {
      record,
      costUsd: priced.costUsd,
      costSource: priced.costSource,
      cacheSavingsUsd: cacheSavingsUsd(
        this.#options.rates,
        record.model,
        record.totals,
        record.serviceTier,
        this.#options.priceOverrides,
      ),
    };
  }

  /** The instants a record must fall in to count. */
  window(): { readonly sinceTimeMs: number; readonly untilTimeMs: number } {
    return this.#hourlyWindow ?? this.#dailyWindow!;
  }

  /**
   * Folds one record in. Returns whether it actually contributed, so callers
   * can derive per-window facts (distinct sessions, for one) from the records
   * that landed rather than everything the mtime prefilter happened to admit.
   */
  add(record: UsageRecord): boolean {
    return this.addPriced(this.price(record));
  }

  /** `add` for a record priced when its transcript was indexed. */
  addPriced(priced: PricedRecord): boolean {
    const { record } = priced;
    if (!this.#accepts(record)) return false;

    if (
      this.#hourlyWindow !== null &&
      (record.timestampMs < this.#hourlyWindow.sinceTimeMs ||
        record.timestampMs >= this.#hourlyWindow.untilTimeMs)
    ) {
      this.#outOfWindow += 1;
      return false;
    }
    const day =
      this.#dailyWindow === null
        ? this.#toDay(record.timestampMs)
        : this.#dailyWindow.dayAt(record.timestampMs);
    if (day === null) {
      this.#outOfWindow += 1;
      return false;
    }

    // A duplicate outside the requested window must not poison an in-window
    // copy from another transcript. The scan admits boundary files by mtime,
    // so this ordering is observable for resumed and forked sessions.
    if (record.dedupeKey !== null) {
      if (this.#seen.has(record.dedupeKey)) {
        this.#duplicatesDropped += 1;
        return false;
      }
      this.#seen.add(record.dedupeKey);
    }

    this.#accumulate(this.#bucketFor(record, day, this.#hourStart(record.timestampMs)), {
      totals: record.totals,
      costUsd: priced.costUsd,
      cacheSavingsUsd: priced.cacheSavingsUsd,
      records: 1,
      unpricedRecords: priced.costSource === "unpriced" ? 1 : 0,
      providerReportedRecords: priced.costSource === "providerReported" ? 1 : 0,
      firstMs: record.timestampMs,
      lastMs: record.timestampMs,
    });
    return true;
  }

  /**
   * Folds in every record of an indexed group that falls in the window, one
   * range per day or hour. Returns whether any record contributed. Indexed
   * groups hold no key another transcript shares, so they skip the dedupe pass.
   */
  addGroup(group: IndexedGroup): boolean {
    if (!this.#accepts(group)) return false;
    const { sinceTimeMs, untilTimeMs } = this.window();
    const start = lowerBound(group.timestamps, sinceTimeMs);
    const end = lowerBound(group.timestamps, untilTimeMs);
    this.#outOfWindow += group.timestamps.length - (end - start);
    let position = start;
    while (position < end) {
      const timestampMs = group.timestamps[position]!;
      let day: string;
      let hourStart = "";
      let bucketEndMs: number;
      if (this.#hourlyWindow !== null) {
        const hour = Math.floor((timestampMs - this.#hourlyWindow.sinceTimeMs) / HOUR_MS);
        bucketEndMs = this.#hourlyWindow.sinceTimeMs + (hour + 1) * HOUR_MS;
        day = this.#toDay(timestampMs);
        hourStart = this.#hourStart(timestampMs);
        // An hour anchored off the zone's midnight can span two local days;
        // records keep the day they happened on, as `add` assigns them.
        if (this.#toDay(bucketEndMs - 1) !== day) {
          bucketEndMs = firstInstantAfterDay(this.#toDay, day, timestampMs, bucketEndMs);
        }
      } else {
        const located = this.#dailyWindow!.dayRangeAt(timestampMs)!;
        day = located.day;
        bucketEndMs = located.endMs;
      }
      const next = Math.min(end, lowerBound(group.timestamps, bucketEndMs));
      this.#accumulate(
        this.#bucketFor(group, day, hourStart),
        readGroupRange(group, position, next),
      );
      position = next;
    }
    return end > start;
  }

  #accepts(record: BucketDimensions): boolean {
    const safeRunId = safeRunIdOf(record);
    return !(
      (this.#providers !== null && !this.#providers.has(record.provider)) ||
      (this.#sessionIds !== null && !this.#sessionIds.has(record.sessionId)) ||
      (this.#runIds !== null && !this.#runIds.has(safeRunId)) ||
      (this.#turnIds !== null && (record.turnId === undefined || !this.#turnIds.has(record.turnId)))
    );
  }

  #hourStart(timestampMs: number): string {
    return this.#hourlyWindow === null
      ? ""
      : new Date(
          this.#hourlyWindow.sinceTimeMs +
            Math.floor((timestampMs - this.#hourlyWindow.sinceTimeMs) / HOUR_MS) * HOUR_MS,
        ).toISOString();
  }

  #bucketFor(record: BucketDimensions, day: string, hourStart: string): MutableBucket {
    const safeRunId = safeRunIdOf(record);
    const safeSessionId =
      record.sessionId.length > 0 && record.sessionId.length <= 512 ? record.sessionId : "";
    const sessionId =
      this.#options.groupBy === "session" || this.#options.groupBy === "turn" ? safeSessionId : "";
    const turnId = this.#options.groupBy === "turn" ? (record.turnId ?? "") : "";
    const runId = this.#options.groupBy === "run" ? safeRunId : "";
    const key = `${day}\u0000${hourStart}\u0000${record.provider}\u0000${record.model}\u0000${record.serviceTier ?? "unknown"}\u0000${record.serviceTierSource ?? "unknown"}\u0000${sessionId}\u0000${turnId}\u0000${runId}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        totals: EMPTY_TOTALS,
        costUsd: 0,
        cacheSavingsUsd: 0,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
        firstActivityAtMs: Number.POSITIVE_INFINITY,
        lastActivityAtMs: Number.NEGATIVE_INFINITY,
      };
      this.#buckets.set(key, bucket);
    }
    const distinctSessionId = this.#options.groupBy === "run" ? safeRunId : safeSessionId;
    if (distinctSessionId !== "") bucket.sessions.add(distinctSessionId);
    return bucket;
  }

  #accumulate(bucket: MutableBucket, range: GroupRange): void {
    bucket.totals = addTotals(bucket.totals, range.totals);
    bucket.costUsd += range.costUsd;
    bucket.cacheSavingsUsd += range.cacheSavingsUsd;
    bucket.records += range.records;
    bucket.firstActivityAtMs = Math.min(bucket.firstActivityAtMs, range.firstMs);
    bucket.lastActivityAtMs = Math.max(bucket.lastActivityAtMs, range.lastMs);
    bucket.unpricedRecords += range.unpricedRecords;
    bucket.providerReportedRecords += range.providerReportedRecords;
  }

  finish(): AggregateResult {
    const buckets: UsageBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [
        day = "",
        hourStart = "",
        provider = "",
        model = "",
        serviceTier = "unknown",
        serviceTierSource = "unknown",
        sessionId = "",
        turnId = "",
        runId = "",
      ] = key.split("\u0000");
      buckets.push({
        day: day as UsageDay,
        ...(hourStart === "" ? {} : { hourStart }),
        provider: provider as UsageBucket["provider"],
        model,
        ...(sessionId === "" ? {} : { sessionId }),
        ...(runId === "" ? {} : { runId }),
        ...(this.#options.groupBy === "run"
          ? {
              firstActivityAt: new Date(bucket.firstActivityAtMs).toISOString(),
              lastActivityAt: new Date(bucket.lastActivityAtMs).toISOString(),
            }
          : {}),
        ...(turnId === "" ? {} : { turnId }),
        ...(provider === "codex"
          ? {
              serviceTier,
              serviceTierSource: serviceTierSource as UsageBucket["serviceTierSource"],
            }
          : {}),
        totals: bucket.totals,
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        costSource: resolveCostSource(bucket),
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        sessions: bucket.sessions.size,
      });
    }
    // Stable ordering keeps payloads diffable and snapshot tests meaningful.
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        (a.hourStart ?? "").localeCompare(b.hourStart ?? "") ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

    return {
      buckets,
      duplicatesDropped: this.#duplicatesDropped,
      outOfWindow: this.#outOfWindow,
    };
  }
}

/**
 * A bucket mixes records from one model, but their cost provenance can differ
 * when only some records carried a reported cost. The weakest provenance in the
 * bucket wins so the UI never overstates confidence.
 */
function resolveCostSource(bucket: MutableBucket): UsageBucket["costSource"] {
  if (bucket.unpricedRecords === bucket.records) return "unpriced";
  if (bucket.providerReportedRecords === bucket.records) return "providerReported";
  return "modelPriced";
}
