import { mapUsageModel } from "./usageAggregation.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { UsageQuotaHistory, UsageQuotaInterval, UsageQuotaSample } from "@t3tools/contracts";

import { priceUsageRecord, type RateTable } from "./usagePricing.ts";
import {
  lowerBound,
  readGroupRange,
  type GroupRange,
  type IndexedGroup,
  type PricedRecord,
} from "./usageRecordIndex.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024;
const MAX_ARCHIVE_FILES = 64;
const MAX_ARCHIVE_ROWS = 1_000;
const SOURCE = "Codex Limits saved history";
const decodeHistoryJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** This boundary reads only the tracker's sanitized percentage samples. */
export function decodeQuotaHistory(document: unknown): UsageQuotaHistory {
  const root = object(document);
  const rows = root?.Samples;
  const invalid: UsageQuotaHistory = {
    status: "invalid",
    source: SOURCE,
    samples: [],
    message: "The saved tracker history is invalid. No quota values were inferred.",
  };
  const main = object(object(root?.Snapshot)?.MainLimit);
  if (main?.LimitId !== "codex" || object(main.Window)?.DurationMinutes !== 10080) return invalid;
  if (!Array.isArray(rows) || rows.length > 5000) return invalid;
  const snapshot = object(root?.Snapshot);
  const emergencyResetCount = snapshot?.EmergencyResetCount;
  const bankedResetCount =
    typeof emergencyResetCount === "number" &&
    Number.isSafeInteger(emergencyResetCount) &&
    emergencyResetCount >= 0
      ? emergencyResetCount
      : undefined;
  const fetchedAt = snapshot?.FetchedAt;
  const fetchedAtMs = typeof fetchedAt === "string" ? Date.parse(fetchedAt) : NaN;
  const samples = new Map<number, UsageQuotaSample>();
  for (const row of rows) {
    const item = object(row);
    if (item === null) return invalid;
    const { ObservedAt, RemainingPercent, ResetsAt } = item;
    if (
      typeof ObservedAt !== "string" ||
      typeof ResetsAt !== "string" ||
      typeof RemainingPercent !== "number" ||
      !Number.isFinite(RemainingPercent) ||
      RemainingPercent < 0 ||
      RemainingPercent > 100
    )
      return invalid;
    const observed = Date.parse(ObservedAt);
    const reset = Date.parse(ResetsAt);
    if (!Number.isFinite(observed) || !Number.isFinite(reset) || observed > reset) return invalid;
    const sample = {
      observedAt: DateTime.formatIso(DateTime.makeUnsafe(observed)),
      remainingPercent: RemainingPercent,
      resetsAt: DateTime.formatIso(DateTime.makeUnsafe(reset)),
    };
    const prior = samples.get(observed);
    if (
      prior &&
      (prior.remainingPercent !== RemainingPercent || prior.resetsAt !== sample.resetsAt)
    ) {
      return invalid;
    }
    samples.set(observed, sample);
  }
  return {
    status: "ready",
    source: SOURCE,
    samples: [...samples.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt)),
    ...(bankedResetCount === undefined ? {} : { bankedResetCount }),
    ...(bankedResetCount === undefined || !Number.isFinite(fetchedAtMs)
      ? {}
      : { bankedResetCheckedAt: DateTime.formatIso(DateTime.makeUnsafe(fetchedAtMs)) }),
    message: null,
  };
}

export const readQuotaHistory = Effect.fn("UsageQuotaHistory.read")(
  function* (override: string | null | undefined) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    const home = yield* HostProcess.HomeDirectory;
    const filePath =
      override === undefined
        ? environment.T3CODE_QUOTA_HISTORY_PATH ||
          (environment.LOCALAPPDATA
            ? path.join(environment.LOCALAPPDATA, "CodexLimits", "state.json")
            : platform === "darwin"
              ? path.join(home, "Library", "Application Support", "CodexLimits", "state.json")
              : null)
        : override;
    const missing: UsageQuotaHistory = {
      status: "missing",
      source: SOURCE,
      samples: [],
      message: "No saved Codex Limits history is available on this environment.",
    };
    if (filePath === null) return missing;
    if (!(yield* fileSystem.exists(filePath))) return missing;
    const stat = yield* fileSystem.stat(filePath);
    if (Number(stat.size) > MAX_HISTORY_BYTES) return decodeQuotaHistory(null);
    const text = yield* fileSystem.readFileString(filePath);
    if (Buffer.byteLength(text, "utf8") > MAX_HISTORY_BYTES) return decodeQuotaHistory(null);
    const json = yield* decodeHistoryJson(text);
    const current = decodeQuotaHistory(json);
    if (current.status !== "ready") return current;
    const archiveDir = `${filePath}.archive`;
    if (!(yield* fileSystem.exists(archiveDir))) return current;
    const names = yield* fileSystem.readDirectory(archiveDir);
    if (
      names.length > MAX_ARCHIVE_FILES ||
      names.some((name) => !/^[a-f0-9]{64}\.json$/.test(name))
    )
      return decodeQuotaHistory(null);
    const samples = new Map(current.samples.map((sample) => [sample.observedAt, sample]));
    for (const name of names) {
      const archivePath = path.join(archiveDir, name);
      const archiveStat = yield* fileSystem.stat(archivePath);
      if (Number(archiveStat.size) > MAX_ARCHIVE_BYTES) return decodeQuotaHistory(null);
      const archiveText = yield* fileSystem.readFileString(archivePath);
      if (Buffer.byteLength(archiveText, "utf8") > MAX_ARCHIVE_BYTES)
        return decodeQuotaHistory(null);
      const crypto = yield* Crypto.Crypto;
      const digest = Buffer.from(
        yield* crypto.digest("SHA-256", Buffer.from(archiveText)),
      ).toString("hex");
      if (`${digest}.json` !== name) {
        return decodeQuotaHistory(null);
      }
      const archive = yield* decodeHistoryJson(archiveText);
      const rows = object(archive)?.Samples;
      if (!Array.isArray(rows) || rows.length > MAX_ARCHIVE_ROWS) return decodeQuotaHistory(null);
      const decoded = decodeQuotaHistory({ Snapshot: object(json)?.Snapshot, Samples: rows });
      if (decoded.status !== "ready") return decoded;
      for (const sample of decoded.samples) {
        const prior = samples.get(sample.observedAt);
        if (
          prior !== undefined &&
          (prior.remainingPercent !== sample.remainingPercent || prior.resetsAt !== sample.resetsAt)
        )
          return decodeQuotaHistory(null);
        samples.set(sample.observedAt, sample);
      }
    }
    return {
      ...current,
      samples: [...samples.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt)),
    };
  },
  Effect.catchCause(() => Effect.succeed(decodeQuotaHistory(null))),
);

/** Intervals must be ordered, disjoint, bounded and inside the scanned days. */
export function validQuotaIntervals(
  intervals: readonly UsageQuotaInterval[],
  sinceDay: string,
  untilDay: string,
): boolean {
  if (intervals.length > 64) return false;
  const earliest = Date.parse(`${sinceDay}T00:00:00Z`) + 24 * 60 * 60 * 1000;
  const latest = Date.parse(`${untilDay}T00:00:00Z`) - 24 * 60 * 60 * 1000;
  let previousEnd = -Infinity;
  const ids = new Set<string>();
  return intervals.every((interval) => {
    const start = Date.parse(interval.sinceTime);
    const end = Date.parse(interval.untilTime);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      start < earliest ||
      end > latest ||
      start < previousEnd ||
      ids.has(interval.id)
    )
      return false;
    previousEnd = end;
    ids.add(interval.id);
    return true;
  });
}

/** Only records accepted by the existing deduplication pass enter this accumulator. */
export class QuotaCostAccumulator {
  readonly rows;
  readonly rates: RateTable;
  readonly overrides: RateTable | undefined;
  readonly provider: "codex" | "claude";
  readonly modelAliases: ReadonlyMap<string, string> | undefined;
  constructor(
    intervals: readonly UsageQuotaInterval[],
    rates: RateTable,
    overrides?: RateTable,
    provider: "codex" | "claude" = "codex",
    modelAliases?: ReadonlyMap<string, string>,
  ) {
    this.rates = rates;
    this.overrides = overrides;
    this.provider = provider;
    this.modelAliases = modelAliases;
    this.rows = intervals.map((interval) => ({
      intervalId: interval.id,
      start: Date.parse(interval.sinceTime),
      end: Date.parse(interval.untilTime),
      costUsd: 0,
      records: 0,
      unpricedRecords: 0,
      models: [] as {
        model: string;
        totals: UsageRecord["totals"];
        costUsd: number;
        records: number;
        unpricedRecords: number;
      }[],
    }));
  }

  add(input: UsageRecord): void {
    const record = mapUsageModel(input, this.modelAliases);
    if (!this.#counts(record)) return;
    const priced = priceUsageRecord(this.rates, record, this.overrides);
    this.addPriced({ record, costUsd: priced.costUsd, costSource: priced.costSource });
  }

  /** `add` for a record priced with this accumulator's rates when it was indexed. */
  addPriced(priced: Pick<PricedRecord, "record" | "costUsd" | "costSource">): void {
    const { record } = priced;
    if (!this.#counts(record)) return;
    // Batched readers can ask for overlapping periods. Each receives its own
    // total, while the enclosing usage summary still counts each record once.
    for (const row of this.rows) {
      if (record.timestampMs < row.start || record.timestampMs >= row.end) continue;
      this.#accumulate(row, record.model, {
        totals: record.totals,
        costUsd: priced.costUsd,
        records: 1,
        unpricedRecords: priced.costSource === "unpriced" ? 1 : 0,
      });
    }
  }

  /**
   * Folds in an indexed group's records inside `[sinceTimeMs, untilTimeMs)`,
   * the window the aggregator accepted them for.
   */
  addGroup(group: IndexedGroup, sinceTimeMs: number, untilTimeMs: number): void {
    if (!this.#counts(group)) return;
    for (const row of this.rows) {
      const start = lowerBound(group.timestamps, Math.max(row.start, sinceTimeMs));
      const end = lowerBound(group.timestamps, Math.min(row.end, untilTimeMs));
      if (end <= start) continue;
      this.#accumulate(row, group.model, readGroupRange(group, start, end));
    }
  }

  #counts(record: Pick<UsageRecord, "provider" | "model">): boolean {
    if (record.provider !== this.provider) return false;
    // Spark has a separate quota; Qwen runs through the CLI without consuming
    // the OpenAI subscription. Neither belongs in its weekly conversion.
    return !(
      this.provider === "codex" &&
      (/spark|bengalfox/i.test(record.model) || /^(?:[^/]+\/)?qwen/i.test(record.model))
    );
  }

  #accumulate(
    row: (typeof this.rows)[number],
    modelName: string,
    range: Pick<GroupRange, "totals" | "costUsd" | "records" | "unpricedRecords">,
  ): void {
    row.costUsd += range.costUsd;
    row.records += range.records;
    row.unpricedRecords += range.unpricedRecords;
    let model = row.models.find((entry) => entry.model === modelName);
    if (!model) {
      model = {
        model: modelName,
        totals: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        costUsd: 0,
        records: 0,
        unpricedRecords: 0,
      };
      row.models.push(model);
    }
    model.totals = {
      uncachedInputTokens: model.totals.uncachedInputTokens + range.totals.uncachedInputTokens,
      cachedInputTokens: model.totals.cachedInputTokens + range.totals.cachedInputTokens,
      cacheCreationTokens: model.totals.cacheCreationTokens + range.totals.cacheCreationTokens,
      outputTokens: model.totals.outputTokens + range.totals.outputTokens,
      reasoningTokens: model.totals.reasoningTokens + range.totals.reasoningTokens,
    };
    model.costUsd += range.costUsd;
    model.records += range.records;
    model.unpricedRecords += range.unpricedRecords;
  }
}
