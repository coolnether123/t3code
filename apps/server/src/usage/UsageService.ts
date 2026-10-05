/**
 * UsageService - scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads the provider CLIs' own session files rather than T3 Code's
 * orchestration projections, so usage covers turns driven outside T3 Code too.
 * This is the approach `ccusage` takes.
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed.
 *
 * @module UsageService
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  USAGE_CONTRACT_VERSION,
  CodexSettings,
  type UsageProviderKind,
  type UsageRepeatedInputCoverageGap,
  type UsageRepeatedInputCatalogItem,
  type UsageRepeatedInputSummary,
  type UsageRepeatedInputBreakdown,
  type UsageRepeatedInputItem,
  type UsageRepeatedInputModelCost,
  type UsageDay,
  type UsageQuotaCost,
  type ServerSettings as ServerSettingsValue,
  type UsagePricing,
  type UsageReport,
  type UsageReportInput,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import {
  codexIsolatedHomePath,
  resolveCodexHomeLayout,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { makeDayFormatter, UsageAggregator } from "./usageAggregation.ts";
import { createOverrideRateTable, parseRateTable, type RateTable } from "./usagePricing.ts";
import { UsageSummaryCache, usageSummaryCacheKey } from "./usageSummaryCache.ts";
import { makeUsageReportCalculation, projectUsageReport } from "./usageReport.ts";
import {
  PromptUsageAccumulator,
  promptUsageTimeBounds,
  validatePromptUsageInput,
} from "./usagePromptReport.ts";
import {
  listTranscriptFilesBounded,
  readDirectoryVolumeId,
  readTranscriptRecords,
  readRepeatedInputRecords,
  readTranscriptPrefixFingerprint,
  transcriptAppendIsSafe,
  selectTranscriptFilesForScan,
  transcriptCursorIsLineBoundary,
  type TranscriptFile,
} from "./usageTranscriptReader.ts";
import {
  aggregateRepeatedInputObservations,
  createPythonTiktokenTokenizer,
  discoverCodexRepeatedInputSources,
  initialRepeatedInputParserState,
  REPEATED_INPUT_CACHE_VERSION,
  type RepeatedInputAggregateResult,
  type RepeatedInputCatalog,
  type RepeatedInputObservation,
  type RepeatedInputParserState,
  type RepeatedInputTokenAttribution,
} from "./usageRepeatedInput.ts";
import {
  decodeScanCacheEntries,
  decodeScanCoverage,
  dedupeWithinFile,
  planTranscriptScan,
  type CachedFile,
  type CachedFileMeta,
} from "./usageScanCache.ts";
import { UsageScanStore } from "./usageScanStore.ts";
import {
  CLAUDE_QUOTA_HISTORY_FILE,
  claudeQuotaHistories,
  decodeClaudeQuotaHistory,
  emptyClaudeQuotaHistory,
} from "./claudeQuotaHistory.ts";
import type { UsageRecord } from "./usageTranscripts.ts";
import {
  applyCodexServiceTier,
  CODEX_FAST_WINDOWS,
  CODEX_TIER_JOURNAL,
  parseCodexFastWindows,
  parseCodexTierJournal,
} from "./codexServiceTier.ts";
import {
  QuotaCostAccumulator,
  readQuotaHistory,
  validQuotaIntervals,
} from "./usageQuotaHistory.ts";
import {
  readQuotaCostLedger,
  upsertQuotaCostLedger,
  writeQuotaCostLedger,
  type QuotaCostLedgerRow,
} from "./usageQuotaCostLedger.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;
/** An explicit refresh ignores the TTL, but not a table fetched this recently. */
const RATES_REFRESH_FLOOR_MS = 60 * 1000;
const SUMMARY_CACHE_TTL_MS = 60 * 1000;
/** Store flag written once the pre-SQLite JSON scan cache has been imported. */
const LEGACY_SCAN_CACHE_IMPORT_FLAG = "legacyJsonImportedAt";
/** Records per import transaction; small enough that each write is brief. */
const LEGACY_SCAN_CACHE_IMPORT_BATCH_ROWS = 5_000;
const MAX_SUMMARY_CACHE_ENTRIES = 16;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Longest window the UI offers. Older entries are pruned. */
const CACHE_RETENTION_DAYS = 365;

/** Keeps a first-time usage read responsive even with very large transcripts. */
const MAX_COLD_SCAN_BYTES_PER_SOURCE = 128 * 1024 * 1024;

/** One complete-line JSONL chunk persisted before the next bounded request resumes it. */
const MAX_TRANSCRIPT_READ_BYTES_PER_FILE = 32 * 1024 * 1024;

/** Leaves enough room in a bounded RPC to scan selected files and serialize its response. */
const MAX_TRANSCRIPT_INVENTORY_DURATION_MS = 2_000;

/** Keep a margin for WebSocket serialization before the consumer's 15-second deadline. */
const MAX_USAGE_READ_DURATION_MS = 12_000;

/** Files changed in this span are checked between complete directory audits. */
const RECENT_TRANSCRIPT_WINDOW_MS = 48 * 60 * 60 * 1000;
/**
 * A page asks for several windows at once. Within this span they share one
 * transcript directory listing instead of each walking the same directories.
 */
const TRANSCRIPT_INVENTORY_REUSE_MS = 10 * 1000;

/** Full audits catch deleted history without putting a tree walk on every request. */
const FULL_SCAN_INTERVAL_MS = 15 * 60 * 1000;

/** Matches the client query TTL while deduplicating requests across clients. */

function includeRepeatedInput(input: UsageSummaryInput): boolean {
  return (
    input.includeRepeatedInput === true &&
    input.quotaHistoryOnly !== true &&
    input.quotaIntervals === undefined
  );
}

function repeatedInputPrice(
  cost: number | null,
  _status: "providerReported" | "estimated" | "unpriced",
): number | null {
  // Mixed rollups retain the priced subtotal while `priceStatus: "unpriced"`
  // makes the incomplete coverage explicit. An entirely unpriced rollup still
  // has a null cost, so unknown tokens are never represented as free.
  return cost;
}

function mapRepeatedInputBreakdown(
  breakdown: RepeatedInputAggregateResult["totals"][number],
): UsageRepeatedInputBreakdown {
  return {
    sourceKind: breakdown.sourceKind,
    model: breakdown.model,
    project: breakdown.project,
    environment: breakdown.environment,
    sinceDay: breakdown.day as UsageDay,
    untilDay: breakdown.day as UsageDay,
    occurrences: breakdown.occurrences,
    sessions: breakdown.sessions,
    turns: breakdown.turns,
    directTokens: breakdown.directTokens,
    fullSessionInputTokens: breakdown.fullSessionInputTokens,
    estimatedApiCostUsd: repeatedInputPrice(breakdown.estimatedApiCostUsd, breakdown.priceStatus),
    priceStatus: breakdown.priceStatus,
  };
}

function mapRepeatedInputSummary(
  aggregate: RepeatedInputAggregateResult,
  additionalGaps: readonly UsageRepeatedInputCoverageGap[] = [],
): UsageRepeatedInputSummary {
  const mapModelCosts = (
    modelCosts: readonly RepeatedInputAggregateResult["items"][number]["modelCosts"][number][],
  ): UsageRepeatedInputModelCost[] =>
    modelCosts.map((modelCost): UsageRepeatedInputModelCost => ({
      // Unknown model identity is retained under a stable display key. Its
      // nullable price status remains unpriced and is never treated as free.
      model: modelCost.model ?? "unknown",
      directTokens: modelCost.directTokens,
      estimatedApiCostUsd: repeatedInputPrice(modelCost.estimatedApiCostUsd, modelCost.priceStatus),
      priceStatus: modelCost.priceStatus,
      occurrences: modelCost.occurrences,
    }));
  const items: UsageRepeatedInputItem[] = aggregate.items.map((item) => ({
    displayName: item.displayName,
    sourceKind: item.sourceKind,
    contentHash: item.contentHash,
    fileRevisionHash: item.fileRevisionHash,
    firstObservedAt: DateTime.formatIso(DateTime.makeUnsafe(item.firstObservedAtMs)),
    lastObservedAt: DateTime.formatIso(DateTime.makeUnsafe(item.lastObservedAtMs)),
    occurrences: item.occurrences,
    affectedSessions: item.affectedSessions,
    affectedTurns: item.affectedTurns,
    confidence: item.confidence,
    confidenceCounts: item.confidenceCounts,
    directTokens: item.directTokens,
    fullSessionInputTokens: item.fullSessionInputTokens,
    modelCosts: mapModelCosts(item.modelCosts),
    breakdowns: item.breakdowns.map(mapRepeatedInputBreakdown),
  }));
  const catalog: UsageRepeatedInputCatalogItem[] = aggregate.catalog.map((item) => ({
    displayName: item.displayName,
    sourceKind: item.sourceKind,
    contentHash: item.contentHash,
    fileRevisionHash: item.fileRevisionHash,
    byteLength: item.byteLength,
    tokenCount: item.tokenCount,
    observed: item.observed,
    firstObservedAt:
      item.firstObservedAtMs === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(item.firstObservedAtMs)),
    lastObservedAt:
      item.lastObservedAtMs === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(item.lastObservedAtMs)),
    occurrences: item.occurrences,
    affectedSessions: item.affectedSessions,
    affectedTurns: item.affectedTurns,
    confidence: item.confidence,
    confidenceCounts: item.confidenceCounts,
    directTokens: item.directTokens,
    fullSessionInputTokens: item.fullSessionInputTokens,
    modelCosts: mapModelCosts(item.modelCosts),
    breakdowns: item.breakdowns.map(mapRepeatedInputBreakdown),
    estimatedApiCostUsd: repeatedInputPrice(item.estimatedApiCostUsd, item.priceStatus),
    priceStatus: item.priceStatus,
  }));

  const gaps = new Map<string, UsageRepeatedInputCoverageGap>();
  for (const gap of [...aggregate.coverageGaps, ...additionalGaps]) {
    const key = `${gap.reason}\u0000${gap.message}`;
    const previous = gaps.get(key);
    gaps.set(
      key,
      previous === undefined ? gap : { ...previous, count: previous.count + gap.count },
    );
  }

  return {
    items,
    catalog,
    totals: aggregate.totals.map(mapRepeatedInputBreakdown),
    coverageGaps: [...gaps.values()],
    estimatedApiCostUsd: repeatedInputPrice(aggregate.estimatedApiCostUsd, aggregate.priceStatus),
    priceStatus: aggregate.priceStatus,
  };
}

function repeatedInputParserStateForCached(
  cached: CachedFile,
  project: string | null,
  environment: string | null,
): RepeatedInputParserState {
  const state = initialRepeatedInputParserState({ project, environment });
  const codexState = cached.codexState;
  if (codexState !== undefined) {
    state.sessionId = codexState.sessionId;
    state.model = codexState.model;
    state.turnId = codexState.turnId;
    state.suppressingForkCopies = codexState.suppressingForkCopies;
    state.forkCopyAnchorMs = codexState.forkCopyAnchorMs;
  }
  state.activeSources = cached.repeatedInputActiveSources ?? [];
  let latest = cached.records[0];
  for (const record of cached.records) {
    if (latest === undefined || record.timestampMs >= latest.timestampMs) latest = record;
  }
  if (latest !== undefined) {
    state.lastInputTokens = latest.totals;
    state.lastTimestampMs = latest.timestampMs;
  }
  state.ordinal = Math.max(cached.records.length, cached.repeatedInputObservations?.length ?? 0);
  return state;
}

function confidenceRank(value: RepeatedInputObservation["confidence"]): number {
  return value === "confirmedPayload" ? 3 : value === "likelyRead" ? 2 : 1;
}

function dedupeRepeatedInputObservations(
  observations: readonly RepeatedInputObservation[],
): readonly RepeatedInputObservation[] {
  const byKey = new Map<string, RepeatedInputObservation>();
  for (const observation of observations) {
    const previous = byKey.get(observation.dedupeKey);
    if (
      previous === undefined ||
      confidenceRank(observation.confidence) > confidenceRank(previous.confidence)
    ) {
      byKey.set(observation.dedupeKey, observation);
    }
  }
  return [...byKey.values()];
}

function addRepeatedInputTokens(
  left: RepeatedInputTokenAttribution,
  right: RepeatedInputTokenAttribution,
): RepeatedInputTokenAttribution {
  return {
    exact: left.exact + right.exact,
    estimated: left.estimated + right.estimated,
    cached: left.cached + right.cached,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    unknown: left.unknown + right.unknown,
  };
}

function attachRepeatedInputUsage(
  observations: readonly RepeatedInputObservation[],
  records: readonly UsageRecord[],
): readonly RepeatedInputObservation[] {
  const empty: RepeatedInputTokenAttribution = {
    exact: 0,
    estimated: 0,
    cached: 0,
    cacheWrite: 0,
    unknown: 0,
  };
  const inputBySession = new Map<string, RepeatedInputTokenAttribution>();
  const modelByTurn = new Map<string, string>();
  for (const record of records) {
    const input = {
      exact: record.totals.uncachedInputTokens,
      estimated: 0,
      cached: record.totals.cachedInputTokens,
      cacheWrite: record.totals.cacheCreationTokens,
      unknown: 0,
    } satisfies RepeatedInputTokenAttribution;
    inputBySession.set(
      record.sessionId,
      addRepeatedInputTokens(inputBySession.get(record.sessionId) ?? empty, input),
    );
    if (record.turnId !== undefined) {
      modelByTurn.set(`${record.sessionId}\u0000${record.turnId}`, record.model);
    }
  }
  return observations.map((observation) => ({
    ...observation,
    fullSessionInputTokens: inputBySession.get(observation.sessionId) ?? empty,
    model:
      observation.model ??
      (observation.turnId === null
        ? null
        : (modelByTurn.get(`${observation.sessionId}\u0000${observation.turnId}`) ?? null)),
  }));
}

/** On-disk shape of the rate snapshot. */
const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const UsageImportsFile = Schema.Struct({
  version: Schema.Literal(1),
  sources: Schema.Array(
    Schema.Struct({
      provider: Schema.Literals(["chatgpt", "aistudio"]),
      path: Schema.String,
    }),
  ),
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const decodeUsageImports = Schema.decodeUnknownEffect(
  Schema.fromJsonString(UsageImportsFile as unknown as Schema.Codec<typeof UsageImportsFile.Type>),
);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

/** The scan cache is narrowed by hand in `usageScanCache`, so JSON is enough here. */
const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeRateDocument = Schema.encodeSync(ScanCacheJson);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    readonly readReport: <Input extends UsageReportInput>(
      input: Input,
    ) => Effect.Effect<Extract<UsageReport, { readonly mode: Input["mode"] }>, UsageReadError>;
    /** Refetches the rate table ahead of its TTL. */
    readonly refreshRates: Effect.Effect<UsagePricing>;
  }
>()("t3/usage/UsageService") {}

const EMPTY_PRICING: UsagePricing = {
  status: "unavailable",
  source: LITELLM_RATES_URL,
  revision: null,
  fetchedAt: null,
  knownModels: 0,
};

const emptyUsageSummary = (input: {
  readonly timeZone: string;
  readonly sinceDay: UsageDay;
  readonly untilDay: UsageDay;
}): UsageSummary => ({
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "1970-01-01T00:00:00.000Z",
  timeZone: input.timeZone,
  sinceDay: input.sinceDay,
  untilDay: input.untilDay,
  buckets: [],
  sources: [],
  pricing: EMPTY_PRICING,
  scanDurationMs: 0,
});

/** Empty summary, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({
    readSummary: (input) => Effect.succeed(emptyUsageSummary(input)),
    readReport: <Input extends UsageReportInput>(input: Input) =>
      Effect.succeed(
        (input.mode === "prompts"
          ? new PromptUsageAccumulator(input).report("1970-01-01T00:00:00.000Z")
          : projectUsageReport(
              emptyUsageSummary(input),
              input,
              makeUsageReportCalculation(EMPTY_PRICING, {}),
            )) as Extract<UsageReport, { readonly mode: Input["mode"] }>,
      ),
    refreshRates: Effect.succeed(EMPTY_PRICING),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const serviceScope = yield* Scope.make("sequential");
  const scanSemaphore = yield* Semaphore.make(1);

  const recentScanAt = new Map<string, number>();
  const recentInventories = new Map<
    string,
    {
      readonly listedAtMs: number;
      readonly listing: Awaited<ReturnType<typeof listTranscriptFilesBounded>>;
    }
  >();
  let repeatedInputCatalog: RepeatedInputCatalog | null = null;
  let repeatedInputCatalogRoots = "";
  let repeatedInputCatalogAtMs = 0;
  let repeatedInputDiscoveryGaps: readonly UsageRepeatedInputCoverageGap[] = [];
  // Tokenizer discovery is intentionally local and optional. If the local
  // tokenizer is unavailable, the projection keeps the payload fingerprint and
  // reports a coverage gap instead of substituting a byte-based token count.
  const repeatedInputTokenizer = createPythonTiktokenTokenizer({ timeoutMs: 2_000 });
  const summaryCache = new UsageSummaryCache(SUMMARY_CACHE_TTL_MS, MAX_SUMMARY_CACHE_ENTRIES);
  // Shares the result only while an identical scan is running. Completed
  // provider-backed summaries are deliberately not retained because transcript
  // changes must be visible to the next request.
  const inFlightSummaries = new Map<
    string,
    Deferred.Deferred<Exit.Exit<UsageSummary, UsageReadError>, never>
  >();
  const readSettings = settingsService.getSettings.pipe(
    Effect.catchCause(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause: Cause.squash(cause),
        }),
    ),
  );
  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  /** The pre-SQLite cache. Imported once, then kept beside the store as a backup. */
  const legacyScanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  const claudeQuotaHistoryPath = path.join(config.stateDir, CLAUDE_QUOTA_HISTORY_FILE);
  // Parsed transcript records live in SQLite; only a small per-file index is
  // resident. See usageScanStore for why the whole-document cache was retired.
  const scanStore = UsageScanStore.open(path.join(config.stateDir, "usage-scan-cache.sqlite"));
  const usageImportsPath = path.join(config.stateDir, "usage-imports.json");
  const quotaCostLedgerPath = path.join(config.stateDir, "usage-quota-cost-ledger.json");
  let quotaCostLedger: readonly QuotaCostLedgerRow[] =
    yield* readQuotaCostLedger(quotaCostLedgerPath);
  let quotaCostLedgerDirty = false;
  let rates: RateTable = new Map();
  let ratesRevision: string | null = null;
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";
  const ratesLock = yield* Semaphore.make(1);
  let cachedRatesLoaded = false;

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing.
   */
  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    revision: ratesRevision,
    fetchedAt:
      ratesFetchedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
    knownModels: rates.size,
  });

  const loadCachedRates = Effect.gen(function* () {
    const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
      Effect.flatMap((raw) => decodeRatesCache(raw)),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fromDisk === null) return;
    const parsed = parseRateTable(fromDisk.document);
    if (parsed.size === 0) return;
    rates = parsed;
    const revisionDocument = encodeRateDocument(fromDisk.document);
    ratesRevision = NodeCrypto.createHash("sha256").update(revisionDocument).digest("hex");
    ratesFetchedAtMs = fromDisk.fetchedAtMs;
    ratesStatus = "cached";
  });
  const ensureCachedRates = ratesLock.withPermits(1)(
    Effect.gen(function* () {
      if (cachedRatesLoaded) return;
      yield* loadCachedRates;
      cachedRatesLoaded = true;
    }),
  );

  const ensureRates = (force = false) =>
    ensureCachedRates.pipe(
      Effect.andThen(
        ratesLock.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
            if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;

            const fetched = yield* httpClient.get(LITELLM_RATES_URL).pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap((response) => response.json),
              Effect.timeout(10_000),
              Effect.catchCause(() => Effect.succeed(null)),
            );
            if (fetched === null) {
              // The refresh failed; whatever we are serving is now past its TTL and
              // must not keep claiming to be fresh.
              if (rates.size > 0) ratesStatus = "cached";
              return;
            }

            const parsed = parseRateTable(fetched);
            if (parsed.size === 0) return;

            rates = parsed;
            const revisionDocument = encodeRateDocument(fetched);
            ratesRevision = NodeCrypto.createHash("sha256").update(revisionDocument).digest("hex");
            ratesFetchedAtMs = now;
            ratesStatus = "fresh";

            yield* encodeRatesCache({ fetchedAtMs: now, document: fetched }).pipe(
              Effect.flatMap((serialized) =>
                fileSystem.writeFileString(ratesCachePath, serialized),
              ),
              Effect.catchCause(() => Effect.void),
            );
          }),
        ),
      ),
    );

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

  /**
   * Claude's config dir is the home itself when overridden, but a default
   * install nests transcripts under `~/.claude/projects`. Probe both.
   */
  const resolveClaudeTranscriptDir = (homePath: string) =>
    Effect.gen(function* () {
      const nested = path.join(homePath, ".claude", "projects");
      const nestedExists = yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      const fallback = path.join(homePath, "projects");
      const fallbackExists = yield* fileSystem
        .exists(fallback)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      return nestedExists ? nested : fallbackExists ? fallback : nested;
    });

  /** Resolves the transcript directory for each provider. */
  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* (
    settings: ServerSettingsValue,
  ) {
    const claudeHome = yield* resolveClaudeHomePath(settings.providers.claudeAgent);
    const claudeDir = yield* resolveClaudeTranscriptDir(claudeHome);
    const codexHomes = new Set<string>();
    const addCodexHome = Effect.fn("UsageService.addCodexHome")(function* (
      instanceId: string,
      codexConfig: CodexSettings,
    ) {
      const layout = yield* resolveCodexHomeLayout(codexConfig);
      // Usage must retain the legacy source while also seeing new T3-owned
      // transcripts. The private home is derived exactly as in CodexDriver.
      codexHomes.add(layout.sharedHomePath);
      if (!codexConfig.useDesktopAppDaemon && codexConfig.shadowHomePath.trim().length === 0) {
        codexHomes.add(codexIsolatedHomePath(path, config.baseDir, instanceId));
      }
    });
    yield* addCodexHome("codex", settings.providers.codex);
    for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
      if (String(instance.driver) !== "codex") continue;
      const codexConfig = yield* decodeCodexSettings(instance.config ?? {}).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (codexConfig !== null) yield* addCodexHome(instanceId, codexConfig);
    }
    const geminiHome = path.join(NodeOS.homedir(), ".gemini");
    const openCodeHome = path.join(NodeOS.homedir(), ".local", "share", "opencode");
    const imports = yield* fileSystem.readFileString(usageImportsPath).pipe(
      Effect.flatMap((raw) => decodeUsageImports(raw)),
      Effect.orElseSucceed(() => null),
    );

    return [
      { provider: "claude" as const, dir: claudeDir },
      ...[...codexHomes].flatMap((codexHome) => [
        { provider: "codex" as const, dir: path.join(codexHome, "sessions") },
        { provider: "codex" as const, dir: path.join(codexHome, "archived_sessions") },
      ]),
      { provider: "gemini" as const, dir: path.join(geminiHome, "tmp") },
      { provider: "gemini" as const, dir: path.join(geminiHome, "antigravity", "brain") },
      { provider: "opencode" as const, dir: openCodeHome },
      ...(imports?.sources ?? [])
        .filter((source) => source.path.trim().length > 0)
        .map((source) => ({ provider: source.provider, dir: path.resolve(source.path) })),
    ];
  });

  type UsageReadContext = {
    readonly settings: ServerSettingsValue;
    readonly dirs: readonly { readonly provider: UsageProviderKind; readonly dir: string }[];
  };

  type RepeatedInputScanFile = TranscriptFile & {
    readonly previous: CachedFileMeta | undefined;
    readonly parserState: RepeatedInputParserState | undefined;
    readonly previousObservations: readonly RepeatedInputObservation[] | undefined;
  };

  type RepeatedInputScanProgress = {
    readonly observations: RepeatedInputObservation[];
    readonly gaps: UsageRepeatedInputCoverageGap[];
    catalog: RepeatedInputCatalog | null;
  };

  type UsageReadProgress = {
    readonly sources: UsageSource[];
    readonly pendingSources: UsageSource[];
    readonly quotaCosts: UsageQuotaCost[];
    quotaHistory: UsageSummary["quotaHistory"];
    providerQuotaHistories: UsageSummary["providerQuotaHistories"];
    aggregator: UsageAggregator | undefined;
    ordinarySummary: UsageSummary | undefined;
    repeatedInput:
      | ((gaps?: readonly UsageRepeatedInputCoverageGap[]) => UsageRepeatedInputSummary)
      | undefined;
  };

  const resolveReadContext = Effect.fn("UsageService.resolveReadContext")(function* () {
    const settings = yield* readSettings;
    const dirs = yield* resolveTranscriptDirs(settings).pipe(
      Effect.provideService(Path.Path, path),
    );
    return { settings, dirs } satisfies UsageReadContext;
  });

  /**
   * Imports the pre-SQLite JSON cache once, in small transactions that yield
   * between them so the server keeps answering while a large cache moves over.
   * The legacy file is renamed, not deleted, so it remains a manual backup.
   */
  const importLegacyScanCache = Effect.gen(function* () {
    if (!scanStore.persistent) {
      yield* Effect.logWarning("Usage scan cache database is unavailable; using a process cache.", {
        cause: String(scanStore.openError),
      });
    }
    if (scanStore.readFlag(LEGACY_SCAN_CACHE_IMPORT_FLAG) !== undefined) return;
    const document = yield* fileSystem.readFileString(legacyScanCachePath).pipe(
      Effect.flatMap((raw) => decodeScanCacheFile(raw)),
      Effect.orElseSucceed(() => null),
    );
    if (document !== null) {
      let batch: [string, CachedFile][] = [];
      let rows = 0;
      for (const [filePath, entry] of decodeScanCacheEntries(document)) {
        // An interrupted import resumes; entries already stored are current.
        if (scanStore.meta(filePath) !== undefined) continue;
        batch.push([filePath, entry]);
        rows += 1 + entry.records.length + (entry.repeatedInputObservations?.length ?? 0);
        if (rows >= LEGACY_SCAN_CACHE_IMPORT_BATCH_ROWS) {
          scanStore.setMany(batch);
          batch = [];
          rows = 0;
          yield* Effect.yieldNow;
        }
      }
      scanStore.setMany(batch);
      for (const coverage of decodeScanCoverage(document)) {
        if (scanStore.coverage(coverage.provider, coverage.rootPath) === undefined) {
          scanStore.setCoverage(coverage);
        }
      }
    }
    if (!scanStore.persistent) return;
    scanStore.writeFlag(LEGACY_SCAN_CACHE_IMPORT_FLAG, DateTime.formatIso(yield* DateTime.now));
    if (document !== null) {
      yield* fileSystem
        .rename(legacyScanCachePath, `${legacyScanCachePath}.imported`)
        .pipe(Effect.ignore);
    }
  }).pipe(Effect.withSpan("UsageService.importLegacyScanCache"));
  // Detached from the request that starts it: a reader that reaches its
  // deadline must not interrupt, and later restart, a half-finished import.
  let legacyScanCacheImport: Fiber.Fiber<void> | undefined;
  const ensureLegacyScanCacheImported = Effect.gen(function* () {
    legacyScanCacheImport ??= yield* Effect.forkIn(importLegacyScanCache, serviceScope, {
      startImmediately: true,
    });
    yield* Fiber.await(legacyScanCacheImport);
  });

  const ensureRepeatedInputCatalog = Effect.fn("UsageService.ensureRepeatedInputCatalog")(
    function* (roots: readonly string[], force: boolean) {
      const now = yield* Clock.currentTimeMillis;
      const key = [...new Set(roots)].sort().join("\u0000");
      if (
        repeatedInputCatalog !== null &&
        repeatedInputCatalogRoots === key &&
        !force &&
        now - repeatedInputCatalogAtMs < SUMMARY_CACHE_TTL_MS
      ) {
        return repeatedInputCatalog;
      }
      const discovery = yield* Effect.promise(() =>
        discoverCodexRepeatedInputSources({
          roots: key.length === 0 ? undefined : key.split("\u0000"),
          tokenizer: repeatedInputTokenizer,
        }),
      );
      repeatedInputCatalog = discovery.catalog;
      repeatedInputCatalogRoots = key;
      repeatedInputCatalogAtMs = now;
      repeatedInputDiscoveryGaps = discovery.gaps.map((gap) => ({
        reason: gap.reason,
        count: 1,
        // Keep the local path private. The source fingerprint and file revision
        // hash are enough provenance for the client without exposing roots.
        message:
          gap.reason === "oversized"
            ? "A reusable input source exceeded the size limit."
            : gap.reason === "missingTokenizer"
              ? "A matching tokenizer was unavailable for a reusable input source."
              : "A reusable input source could not be read.",
      }));
      return repeatedInputCatalog;
    },
  );

  const persistQueue = yield* Queue.dropping<void>(1);
  const persistQuotaCostLedgerOnce = Effect.fn("UsageService.persistQuotaCostLedger")(function* () {
    if (!quotaCostLedgerDirty) return true;
    const rows = quotaCostLedger;
    const persisted = yield* writeQuotaCostLedger(quotaCostLedgerPath, rows).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    if (persisted && rows === quotaCostLedger) quotaCostLedgerDirty = false;
    return persisted;
  });
  const runPersistWorker = Effect.gen(function* () {
    while (true) {
      yield* Queue.take(persistQueue);
      yield* persistQuotaCostLedgerOnce();
    }
  });
  // Keep exactly one consumer alive for the service lifetime. Queue wakes are
  // deliberately lossy: the ledger is written whole, so one wake publishes
  // every change made before it runs. Scan-cache rows are written as they
  // change and need no worker.
  const persistWorker = yield* Effect.forkIn(runPersistWorker, serviceScope, {
    startImmediately: true,
  });
  yield* Effect.addFinalizer(() =>
    Effect.uninterruptible(
      Scope.close(serviceScope, Exit.void).pipe(
        Effect.andThen(Fiber.await(persistWorker)),
        Effect.andThen(persistQuotaCostLedgerOnce()),
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => scanStore.close())),
      ),
    ),
  );

  /** Parses one transcript, reusing the cached result when it is unchanged. */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    requestedStartByte: number,
  ): Effect.Effect<{ readonly records: readonly UsageRecord[]; readonly complete: boolean }> =>
    Effect.gen(function* () {
      const meta = scanStore.meta(filePath);
      // Provider is part of the identity: if both providers were ever pointed
      // at one directory, a hit parsed by the other parser must not be reused.
      if (
        meta &&
        meta.size === size &&
        meta.mtimeMs === mtimeMs &&
        meta.provider === provider &&
        meta.scanCursor === undefined &&
        meta.scanSkippedLines === undefined &&
        meta.scanDiscardingLine !== true
      ) {
        const warm = scanStore.load(filePath);
        if (warm !== undefined) return { records: warm.records, complete: true };
      }

      // A resumable entry whose row can no longer be read is parsed again
      // from the start rather than appended to nothing.
      const cached = requestedStartByte > 0 ? scanStore.load(filePath) : undefined;
      const appendable = cached !== undefined;
      const startByte = appendable ? requestedStartByte : 0;
      const parsed = yield* Effect.promise(() =>
        readTranscriptRecords(filePath, provider, {
          startByte,
          endByte: Math.min(size - 1, startByte + MAX_TRANSCRIPT_READ_BYTES_PER_FILE - 1),
          sourceSize: size,
          ...(appendable && cached.scanDiscardingLine === true ? { discardPartialLine: true } : {}),
          ...(appendable && provider === "codex" && cached.codexState !== undefined
            ? { codexState: cached.codexState }
            : {}),
        }),
      );
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null) return { records: [], complete: false };
      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The aggregator still runs the cross-file dedupe pass.
      const records = dedupeWithinFile([...(appendable ? cached.records : []), ...parsed.records]);
      const nextByte = Math.min(size, Math.max(startByte, parsed.nextByte));
      const scanSkippedLines =
        (appendable ? (cached.scanSkippedLines ?? 0) : 0) + parsed.discardedLines;
      const reachedEnd = nextByte >= size && !parsed.discardingLine;
      const complete = reachedEnd && scanSkippedLines === 0;

      // Written immediately: a later source can exhaust the response budget,
      // and the next request, including after a restart, must resume from this
      // complete-line cursor instead of parsing the chunk again. A file that
      // only grew appends its new records rather than rewriting its history.
      scanStore.set(filePath, {
        size,
        mtimeMs,
        provider,
        records,
        ...(reachedEnd ? {} : { scanCursor: nextByte }),
        ...(scanSkippedLines === 0 ? {} : { scanSkippedLines }),
        ...(parsed.discardingLine ? { scanDiscardingLine: true } : {}),
        ...(parsed.codexState === undefined ? {} : { codexState: parsed.codexState }),
      });
      return { records, complete };
    });

  /** Optional attribution runs after ordinary totals, with a separate byte budget. */
  const readRepeatedInputAttribution = Effect.fn("UsageService.readRepeatedInputAttribution")(
    function* (
      input: UsageSummaryInput,
      dirs: UsageReadContext["dirs"],
      fileGroups: readonly (readonly RepeatedInputScanFile[])[],
      progress: RepeatedInputScanProgress,
      hostId: string,
    ) {
      if (input.providers === undefined || input.providers.includes("codex")) {
        const inputRoots = dirs
          .filter(({ provider }) => provider === "codex")
          .flatMap(({ dir }) => {
            const home = path.dirname(dir);
            return [path.join(home, "skills"), path.join(home, "plugins")];
          });
        progress.catalog = yield* ensureRepeatedInputCatalog(inputRoots, input.refresh === true);
        progress.gaps.push(...repeatedInputDiscoveryGaps);
      }
      for (const group of fileGroups) {
        const planned = yield* Effect.forEach(
          group,
          Effect.fnUntraced(function* (file) {
            const cached = file.previous;
            const parserMatches = cached?.repeatedInputVersion === REPEATED_INPUT_CACHE_VERSION;
            const warm =
              cached !== undefined &&
              cached.size === file.size &&
              cached.mtimeMs === file.mtimeMs &&
              cached.provider === "codex" &&
              cached.scanCursor === undefined &&
              cached.scanSkippedLines === undefined &&
              cached.scanDiscardingLine !== true &&
              parserMatches &&
              cached.hasRepeatedInput &&
              scanStore.meta(file.path)?.hasRepeatedInput === true;
            const appendable =
              !warm &&
              parserMatches &&
              cached !== undefined &&
              cached.provider === "codex" &&
              file.parserState !== undefined &&
              file.size > cached.size &&
              cached.prefixFingerprint !== undefined &&
              (yield* Effect.promise(() =>
                transcriptAppendIsSafe(file.path, {
                  offset: cached.size,
                  prefixFingerprint: cached.prefixFingerprint!,
                }),
              ));
            return {
              ...file,
              warm,
              appendable,
              startByte: warm ? file.size : appendable ? cached!.size : 0,
            };
          }),
          { concurrency: 16 },
        );
        const selection = selectTranscriptFilesForScan(
          planned,
          (file) => file.size - file.startByte,
          MAX_COLD_SCAN_BYTES_PER_SOURCE,
        );
        if (selection.deferredFiles > 0) {
          progress.gaps.push({
            reason: "unattributed",
            count: selection.deferredFiles,
            message:
              "Some Codex transcript files were deferred before repeated-input attribution could inspect them.",
          });
        }
        for (const file of selection.files) {
          const { warm, appendable, startByte } = file;
          const cached = warm ? scanStore.load(file.path) : undefined;
          let observations = cached?.repeatedInputObservations;
          let gaps = cached?.repeatedInputGaps;
          let activeSources = cached?.repeatedInputActiveSources;
          if (cached === undefined) {
            const parserState = appendable ? file.parserState : undefined;
            const parsed = yield* Effect.promise(() =>
              readRepeatedInputRecords(file.path, {
                startByte,
                endByte: file.size - 1,
                catalog: progress.catalog ?? undefined,
                maxPayloadBytes: 4 * 1024 * 1024,
                project: null,
                environment: hostId,
                ...(parserState === undefined ? {} : { parserState }),
              }),
            );
            observations =
              parsed === null
                ? []
                : dedupeRepeatedInputObservations([
                    ...(appendable ? (file.previousObservations ?? []) : []),
                    ...parsed.observations,
                  ]);
            gaps = parsed?.gaps ?? [
              {
                reason: "unavailable",
                count: 1,
                message: "The Codex transcript could not be read for repeated-input attribution.",
              },
            ];
            activeSources = parsed?.parserState.activeSources ?? [];
          }
          const entry = cached ?? scanStore.load(file.path);
          observations = attachRepeatedInputUsage(observations ?? [], entry?.records ?? []);
          progress.observations.push(...observations);
          progress.gaps.push(...(gaps ?? []));
          if (cached === undefined && entry !== undefined) {
            const prefixFingerprint = yield* Effect.promise(() =>
              readTranscriptPrefixFingerprint(file.path, file.size),
            );
            scanStore.set(file.path, {
              ...entry,
              ...(prefixFingerprint === null ? {} : { prefixFingerprint }),
              repeatedInputObservations: observations,
              repeatedInputGaps: gaps ?? [],
              repeatedInputActiveSources: activeSources ?? [],
              repeatedInputVersion: REPEATED_INPUT_CACHE_VERSION,
            });
          }
        }
      }
    },
  );

  const readSummaryUnlocked = Effect.fn("UsageService.readSummaryUnlocked")(function* (
    input: UsageSummaryInput,
    context: UsageReadContext | undefined,
    progress?: UsageReadProgress,
  ) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 24 hours",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    const quotaIntervals = input.quotaIntervals ?? [];
    const quotaProvider = input.quotaProvider ?? "codex";
    if (!validQuotaIntervals(quotaIntervals, input.sinceDay, input.untilDay)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail:
          "Quota intervals must be ordered, disjoint, and inside the scanned window with two days of padding.",
      });
    }
    const quotaHistory =
      input.includeQuotaHistory || input.quotaHistoryOnly || input.quotaIntervals !== undefined
        ? yield* readQuotaHistory(undefined).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          )
        : undefined;
    // Claude windows come from the sampler's saved readings, beside Codex's.
    const providerQuotaHistories =
      input.includeQuotaHistory || input.quotaHistoryOnly || input.quotaIntervals !== undefined
        ? yield* fileSystem.readFileString(claudeQuotaHistoryPath).pipe(
            Effect.flatMap((text) => decodeScanCacheFile(text)),
            Effect.map((document) => claudeQuotaHistories(decodeClaudeQuotaHistory(document))),
            Effect.orElseSucceed(() => claudeQuotaHistories(emptyClaudeQuotaHistory)),
          )
        : undefined;
    if (progress !== undefined) {
      progress.quotaHistory = quotaHistory;
      progress.providerQuotaHistories = providerQuotaHistories;
    }
    if (input.quotaHistoryOnly) {
      const finishedAtMs = yield* Clock.currentTimeMillis;
      return {
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: DateTime.formatIso(DateTime.makeUnsafe(finishedAtMs)),
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: {
          status: "unavailable",
          source: "Not requested",
          revision: null,
          fetchedAt: null,
          knownModels: 0,
        },
        scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
        quotaHistory,
        ...(providerQuotaHistories === undefined ? {} : { providerQuotaHistories }),
        quotaCostSnapshots:
          input.quotaIntervals === undefined
            ? quotaCostLedger
            : quotaCostLedger.filter((row) =>
                input.quotaIntervals!.some((interval) => interval.id === row.intervalId),
              ),
      } satisfies UsageSummary;
    }
    const quotaCosts = progress?.quotaCosts ?? [];
    // A usage read has a hard response budget. Use the rates already available
    // at its start and let the regular refresh populate the next read; never let
    // the pricing endpoint consume this scan's budget or change its prices
    // partway through aggregation.
    const scanRates = new Map(rates);
    const scanPricing = pricing();
    yield* Effect.forkDetach(ensureRates().pipe(Effect.withSpan("UsageService.ensureRates")));
    yield* ensureLegacyScanCacheImported;
    const tierJournal = yield* fileSystem
      .readFileString(path.join(config.stateDir, CODEX_TIER_JOURNAL))
      .pipe(Effect.catchCause(() => Effect.succeed("")));
    const tiers = parseCodexTierJournal(tierJournal);
    const fastWindowText = yield* fileSystem
      .readFileString(path.join(config.stateDir, CODEX_FAST_WINDOWS))
      .pipe(Effect.catchCause(() => Effect.succeed("[]")));
    const fastWindows = yield* Effect.try({
      try: () => parseCodexFastWindows(fastWindowText),
      catch: (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: `Invalid local Codex Fast Mode windows: ${String(cause)}`,
        }),
    });

    const hostId = NodeOS.hostname();
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so `readSummary` stays context-free.
    if (context === undefined) {
      return yield* Effect.die("A transcript usage read requires its resolved source context.");
    }
    const { settings } = context;
    let dirs = context.dirs;
    const claudeDir = dirs.find((source) => source.provider === "claude")?.dir;
    if (claudeDir !== undefined) {
      const claudeHome =
        path.basename(path.dirname(claudeDir)) === ".claude"
          ? path.dirname(path.dirname(claudeDir))
          : path.dirname(claudeDir);
      const claudeCandidates = [
        path.join(claudeHome, ".claude", "projects"),
        path.join(claudeHome, "projects"),
      ];
      const existingClaudeRoot = yield* Effect.filter(claudeCandidates, (candidate) =>
        fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)),
      );
      if (existingClaudeRoot.length === 0) {
        const retainedRoot = scanStore
          .coverageValues()
          .find(
            (entry) => entry.provider === "claude" && claudeCandidates.includes(entry.rootPath),
          )?.rootPath;
        if (retainedRoot !== undefined) {
          dirs = dirs.map((source) =>
            source.provider === "claude" ? { ...source, dir: retainedRoot } : source,
          );
        }
      }
    }
    const repeatedInputEnabled = includeRepeatedInput(input);
    const repeatedInputProgress: RepeatedInputScanProgress = {
      observations: [],
      gaps: [],
      catalog: null,
    };
    const repeatedInputFileGroups: RepeatedInputScanFile[][] = [];
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;
    // The index records each file's latest mtime, record, and observation, so
    // a window is filtered without decoding any history it does not need.
    const cacheEntryTouchesWindow = (meta: CachedFileMeta) => meta.latestMs >= windowStartMs;

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates: scanRates,
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
      ...(input.providers === undefined ? {} : { providers: input.providers }),
      ...(input.runIds === undefined ? {} : { runIds: input.runIds }),
      ...(input.sessionIds === undefined ? {} : { sessionIds: input.sessionIds }),
      ...(input.turnIds === undefined ? {} : { turnIds: input.turnIds }),
      ...(input.groupBy === undefined ? {} : { groupBy: input.groupBy }),
    });
    if (progress !== undefined) progress.aggregator = aggregator;

    const sources = progress?.sources ?? [];
    const selectedProviders = input.providers === undefined ? null : new Set(input.providers);
    const selectedSessionIds = input.sessionIds === undefined ? null : new Set(input.sessionIds);
    const selectedTurnIds = input.turnIds === undefined ? null : new Set(input.turnIds);
    const repeatedDayAt = makeDayFormatter(input.timeZone);
    const repeatedInputSummary = (additionalGaps: readonly UsageRepeatedInputCoverageGap[] = []) =>
      mapRepeatedInputSummary(
        aggregateRepeatedInputObservations(
          repeatedInputProgress.observations.filter((observation) => {
            if (selectedSessionIds !== null && !selectedSessionIds.has(observation.sessionId)) {
              return false;
            }
            if (
              selectedTurnIds !== null &&
              (observation.turnId === null || !selectedTurnIds.has(observation.turnId))
            ) {
              return false;
            }
            if (
              hourlyWindow !== null &&
              (observation.observedAtMs < hourlyWindow.sinceTimeMs ||
                observation.observedAtMs >= hourlyWindow.untilTimeMs)
            ) {
              return false;
            }
            const day = repeatedDayAt(observation.observedAtMs);
            return day >= input.sinceDay && day <= input.untilDay;
          }),
          {
            rates: scanRates,
            priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
            dayAt: repeatedDayAt,
            coverageGaps: [...repeatedInputProgress.gaps, ...additionalGaps],
            catalog: repeatedInputProgress.catalog?.sources ?? [],
          },
        ),
      );
    if (progress !== undefined && repeatedInputEnabled)
      progress.repeatedInput = repeatedInputSummary;
    const activeDirs = dirs.filter(
      ({ provider }) =>
        (input.quotaIntervals === undefined || provider === (input.quotaProvider ?? "codex")) &&
        (selectedProviders === null || selectedProviders.has(provider)),
    );
    const plannedSources = yield* Effect.forEach(
      activeDirs,
      Effect.fnUntraced(function* ({ provider, dir }) {
        const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
        const exists = yield* fileSystem
          .exists(dir)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));
        if (!exists) return { provider, dir, volumeId, exists: false as const };

        const coverageKey = `${provider}\u0000${dir}`;
        const coverage = scanStore.coverage(provider, dir);
        const lastRecentScanAt = recentScanAt.get(coverageKey) ?? 0;
        const plan = planTranscriptScan({
          coverage,
          windowStartMs,
          nowMs: startedAtMs,
          lastRecentScanAtMs: lastRecentScanAt,
          // Every summary read checks the current transcript inventory. The
          // per-file cache still avoids rereading unchanged transcript bytes.
          incrementalScanTtlMs: 0,
          recentTranscriptWindowMs: RECENT_TRANSCRIPT_WINDOW_MS,
          fullScanIntervalMs: FULL_SCAN_INTERVAL_MS,
        });
        const inventoryKey = `${coverageKey}\u0000${plan.scanStartMs}`;
        const reusable = recentInventories.get(inventoryKey);
        const listing = !plan.shouldRefresh
          ? { files: [], complete: true }
          : reusable !== undefined &&
              reusable.listing.complete &&
              startedAtMs - reusable.listedAtMs < TRANSCRIPT_INVENTORY_REUSE_MS
            ? reusable.listing
            : yield* Effect.promise(() =>
                listTranscriptFilesBounded(
                  dir,
                  plan.scanStartMs,
                  provider,
                  MAX_TRANSCRIPT_INVENTORY_DURATION_MS,
                ),
              ).pipe(
                Effect.tap((fresh) =>
                  Effect.sync(() => {
                    recentInventories.set(inventoryKey, {
                      listedAtMs: startedAtMs,
                      listing: fresh,
                    });
                  }),
                ),
              );
        return {
          provider,
          dir,
          volumeId,
          exists: true as const,
          coverageKey,
          discoveredFiles: listing.files,
          listingComplete: listing.complete,
          ...plan,
        };
      }),
      { concurrency: 8 },
    ).pipe(Effect.withSpan("UsageService.planTranscriptSources"));

    for (const source of plannedSources) {
      const { provider, dir, volumeId } = source;
      if (!source.exists) {
        const coverage = scanStore.coverage(provider, dir);
        const retainedFiles = [...scanStore.index()].flatMap(([filePath, meta]) => {
          if (meta.provider !== provider || !cacheEntryTouchesWindow(meta)) return [];
          const relative = path.relative(dir, filePath);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            return [];
          }
          const entry = scanStore.load(filePath);
          return entry === undefined ? [] : [[filePath, entry] as const];
        });
        const sessionIds = new Set<string>();
        let scannedFiles = 0;
        const retainedVolumeId = coverage?.volumeId ?? volumeId;
        const quota = new QuotaCostAccumulator(
          provider === quotaProvider ? quotaIntervals : [],
          scanRates,
          createOverrideRateTable(settings.usagePriceOverrides),
          quotaProvider,
        );
        for (const [, entry] of retainedFiles) {
          if (entry.records.length > 0) scannedFiles += 1;
          if (
            repeatedInputEnabled &&
            provider === "codex" &&
            entry.repeatedInputObservations !== undefined
          ) {
            repeatedInputProgress.observations.push(...entry.repeatedInputObservations);
            repeatedInputProgress.gaps.push(...(entry.repeatedInputGaps ?? []));
          }
          for (const rawRecord of entry.records) {
            const record = applyCodexServiceTier(rawRecord, tiers, fastWindows);
            if (aggregator.add(record)) {
              if (record.sessionId.length > 0) sessionIds.add(record.sessionId);
              if (quotaIntervals.length > 0) quota.add(record);
            }
          }
        }
        for (const { start: _start, end: _end, ...cost } of quota.rows) {
          quotaCosts.push({
            ...cost,
            complete: false,
            fingerprint: {
              hostId,
              provider,
              resolvedHomePath: dir,
              volumeId: retainedVolumeId,
            },
          });
        }
        sources.push({
          fingerprint: {
            hostId,
            provider,
            resolvedHomePath: dir,
            volumeId: retainedVolumeId,
          },
          status: retainedFiles.length > 0 ? "partial" : "missing",
          scannedFiles,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: sessionIds.size,
          message:
            retainedFiles.length > 0
              ? "Usage is partial because the transcript directory is unavailable; retained cached transcripts are included."
              : provider === "chatgpt" || provider === "aistudio"
                ? "Configured chat archive directory was not found on this environment."
                : "No transcript directory on this environment.",
        });
        continue;
      }

      const {
        coverageKey,
        discoveredFiles,
        hasCurrentCoverage,
        listingComplete,
        shouldRefresh,
        scanStartMs,
      } = source;
      const filesByPath = new Map<string, TranscriptFile>();

      for (const [filePath, entry] of scanStore.index()) {
        if (entry.provider !== provider || !cacheEntryTouchesWindow(entry)) continue;
        const relative = path.relative(dir, filePath);
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          continue;
        }
        filesByPath.set(filePath, {
          path: filePath,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
        });
      }
      for (const file of discoveredFiles) filesByPath.set(file.path, file);
      const files = [...filesByPath.values()];
      const plannedFiles = yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (file) {
          const cached = scanStore.meta(file.path);
          const warm =
            cached !== undefined &&
            cached.size === file.size &&
            cached.mtimeMs === file.mtimeMs &&
            cached.provider === provider &&
            cached.scanCursor === undefined &&
            cached.scanSkippedLines === undefined &&
            cached.scanDiscardingLine !== true;
          const resumePartial =
            cached !== undefined &&
            cached.size === file.size &&
            cached.mtimeMs === file.mtimeMs &&
            cached.provider === provider &&
            cached.scanCursor !== undefined;
          const resumeByte = resumePartial ? cached!.scanCursor! : cached?.size;
          const cursorIsUsable =
            !warm &&
            resumeByte !== undefined &&
            resumeByte > 0 &&
            (cached?.scanDiscardingLine === true ||
              (yield* Effect.promise(() => transcriptCursorIsLineBoundary(file.path, resumeByte))));
          const appendable =
            !warm &&
            cached !== undefined &&
            cursorIsUsable &&
            (resumePartial || (cached.scanCursor === undefined && file.size > cached.size)) &&
            (resumePartial || cached.provider === provider) &&
            (provider === "claude" || (provider === "codex" && cached.hasCodexState));
          const startByte = warm ? file.size : appendable ? resumeByte : 0;
          return { ...file, startByte };
        }),
        { concurrency: 16 },
      ).pipe(Effect.withSpan("UsageService.planTranscriptFiles"));
      const selection = selectTranscriptFilesForScan(
        plannedFiles,
        (file) => file.size - file.startByte,
        MAX_COLD_SCAN_BYTES_PER_SOURCE,
      );
      if (repeatedInputEnabled && provider === "codex" && selection.deferredFiles > 0) {
        // The ordinary Usage scan may intentionally defer cold files to keep a
        // long-range request responsive. Repeated-input attribution must make
        // that boundary visible instead of presenting a complete-looking
        // aggregate from the subset that happened to fit the budget.
        repeatedInputProgress.gaps.push({
          reason: "unattributed",
          count: selection.deferredFiles,
          message:
            "Some Codex transcript files were deferred before repeated-input attribution could inspect them.",
        });
      }

      let scannedFiles = 0;
      let skippedFiles = selection.deferredFiles;
      let incompleteFiles = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();
      const quota = new QuotaCostAccumulator(
        provider === quotaProvider ? quotaIntervals : [],
        scanRates,
        createOverrideRateTable(settings.usagePriceOverrides),
        quotaProvider,
      );
      const repeatedInputFiles: (typeof repeatedInputFileGroups)[number] = [];
      if (repeatedInputEnabled && provider === "codex")
        repeatedInputFileGroups.push(repeatedInputFiles);

      for (const file of selection.files) {
        // An unchanged transcript whose newest usage predates the window has
        // nothing to contribute; its index row says so without decoding it.
        const stored = scanStore.meta(file.path);
        if (
          !repeatedInputEnabled &&
          stored !== undefined &&
          stored.size === file.size &&
          stored.mtimeMs === file.mtimeMs &&
          stored.provider === provider &&
          stored.scanCursor === undefined &&
          stored.scanSkippedLines === undefined &&
          stored.scanDiscardingLine !== true &&
          stored.latestMs < windowStartMs
        ) {
          if (stored.recordCount > 0) scannedFiles += 1;
          else skippedFiles += 1;
          continue;
        }
        // Keep only the append state that an ordinary cache write would replace.
        // Warm attribution reloads one file at a time after ordinary aggregation.
        const previous = scanStore.meta(file.path);
        const cachedBefore =
          repeatedInputEnabled &&
          provider === "codex" &&
          previous !== undefined &&
          file.size > previous.size &&
          previous.hasRepeatedInput &&
          previous.repeatedInputVersion === REPEATED_INPUT_CACHE_VERSION
            ? scanStore.load(file.path)
            : undefined;
        const parserState =
          cachedBefore === undefined
            ? undefined
            : repeatedInputParserStateForCached(cachedBefore, null, hostId);
        const fileRead = yield* readFileRecords(
          file.path,
          file.size,
          file.mtimeMs,
          provider,
          file.startByte,
        );
        const { records } = fileRead;
        if (!fileRead.complete) incompleteFiles += 1;
        if (repeatedInputEnabled && provider === "codex") {
          repeatedInputFiles.push({
            ...file,
            previous,
            parserState,
            previousObservations: cachedBefore?.repeatedInputObservations,
          });
        }
        if (records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        for (const rawRecord of records) {
          const record = applyCodexServiceTier(rawRecord, tiers, fastWindows);
          // Only sessions that contributed in-window count: the mtime slack
          // admits boundary files whose records fall outside the range.
          if (aggregator.add(record)) {
            if (record.sessionId.length > 0) sessionIds.add(record.sessionId);
            if (quotaIntervals.length > 0) quota.add(record);
          }
        }
      }

      const scanCompleted =
        listingComplete &&
        selection.deferredFiles === 0 &&
        selection.files.every((file) => {
          const cached = scanStore.meta(file.path);
          return (
            cached !== undefined &&
            cached.size === file.size &&
            cached.mtimeMs === file.mtimeMs &&
            cached.provider === provider &&
            cached.scanCursor === undefined &&
            cached.scanSkippedLines === undefined &&
            cached.scanDiscardingLine === undefined
          );
        });
      if (shouldRefresh && scanCompleted) {
        recentScanAt.set(coverageKey, startedAtMs);
        const existingCoverage = scanStore.coverage(provider, dir);
        if (!hasCurrentCoverage) {
          scanStore.setCoverage({
            provider,
            rootPath: dir,
            sinceMs: scanStartMs,
            scannedAtMs: startedAtMs,
            volumeId,
          });
        } else if (existingCoverage !== undefined && existingCoverage.volumeId !== volumeId) {
          scanStore.setCoverage({ ...existingCoverage, volumeId });
        }
      }

      for (const { start: _start, end: _end, ...cost } of quota.rows) {
        quotaCosts.push({
          ...cost,
          complete: scanCompleted,
          fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
        });
      }
      sources.push({
        fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
        status: !scanCompleted ? "partial" : "ok",
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message: !listingComplete
          ? "Usage is partial because the transcript inventory exceeded its response budget."
          : incompleteFiles > 0
            ? `Usage is partial while ${incompleteFiles} large transcript ${incompleteFiles === 1 ? "is" : "files are"} scanned in complete-line chunks.`
            : selection.deferredFiles > 0
              ? `Usage is partial while the transcript cache warms; ${selection.deferredFiles} older or oversized transcript files were deferred.`
              : provider === "aistudio"
                ? "AI Studio exports use exact chunk counts and source message dates when present. Older exports without createTime remain on their downloaded-file date; per-turn input context is reconstructed and copied branch prefixes are counted once."
                : provider === "chatgpt"
                  ? scannedFiles === 0
                    ? "ChatGPT import is ready; no conversations.json export has been downloaded yet."
                    : "ChatGPT exports contain message dates but no token ledger; token counts and API-equivalent cost are estimated from chat text."
                  : null,
      });
    }

    scanStore.prune(startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const recordedAt = DateTime.formatIso(DateTime.makeUnsafe(startedAtMs));
    for (const cost of quotaCosts) {
      const interval = quotaIntervals.find((candidate) => candidate.id === cost.intervalId);
      const first = quotaHistory?.samples.find(
        (sample) => sample.observedAt === interval?.sinceTime,
      );
      const last = quotaHistory?.samples.find(
        (sample) => sample.observedAt === interval?.untilTime,
      );
      if (!interval || !first || !last) continue;
      const next = upsertQuotaCostLedger(
        quotaCostLedger,
        cost,
        cost.fingerprint,
        {
          ...interval,
          firstRemainingPercent: first.remainingPercent,
          lastRemainingPercent: last.remainingPercent,
          resetsAt: first.resetsAt,
        },
        recordedAt,
      );
      if (next !== quotaCostLedger) {
        quotaCostLedger = next;
        quotaCostLedgerDirty = true;
      }
    }
    // Ledger persistence is derived work. Wake the permanent consumer without
    // making the response wait for the write.
    if (quotaCostLedgerDirty) yield* Queue.offer(persistQueue, undefined);

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;
    const clientContractVersion = input.clientContractVersion ?? 5;
    const supportsOpenCode = clientContractVersion >= 6;
    const supportsImports = clientContractVersion >= 7;
    const supportsProvider = (provider: UsageProviderKind) =>
      (provider !== "opencode" || supportsOpenCode) &&
      ((provider !== "chatgpt" && provider !== "aistudio") || supportsImports);

    const ordinarySummary = {
      contractVersion: supportsImports ? USAGE_CONTRACT_VERSION : supportsOpenCode ? 6 : 5,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets.filter((bucket) => supportsProvider(bucket.provider)),
      sources: sources.filter((source) => supportsProvider(source.fingerprint.provider)),
      pricing: scanPricing,
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
      ...(quotaHistory === undefined ? {} : { quotaHistory }),
      ...(providerQuotaHistories === undefined ? {} : { providerQuotaHistories }),
      ...(input.quotaIntervals === undefined ? {} : { quotaCosts }),
      ...(input.quotaIntervals === undefined
        ? {}
        : {
            quotaCostSnapshots: quotaCostLedger.filter((row) =>
              input.quotaIntervals!.some((interval) => interval.id === row.intervalId),
            ),
          }),
    } satisfies UsageSummary;
    if (!repeatedInputEnabled) return ordinarySummary;
    if (progress !== undefined) progress.ordinarySummary = ordinarySummary;

    yield* readRepeatedInputAttribution(
      input,
      dirs,
      repeatedInputFileGroups,
      repeatedInputProgress,
      hostId,
    );
    return {
      ...ordinarySummary,
      repeatedInput: repeatedInputSummary(),
      scanDurationMs: Math.max(0, (yield* Clock.currentTimeMillis) - startedAtMs),
    } satisfies UsageSummary;
  });

  // A cache miss is decided from mutable per-file state. Serializing summary
  // scans makes that decision single-flight: a second window waits for the
  // first scan to persist its newly warm files instead of parsing them again.
  const repeatedAwareSummaryCacheKey = (
    input: UsageSummaryInput,
    priceOverrides: Readonly<Record<string, unknown>> | undefined,
  ): string => {
    const base = usageSummaryCacheKey(input, priceOverrides);
    return JSON.stringify([base, ratesRevision, includeRepeatedInput(input)]);
  };

  const partialSummaryAtDeadline = Effect.fn("UsageService.partialSummaryAtDeadline")(function* (
    input: UsageSummaryInput,
    startedAtMs: number,
    dirs: readonly { readonly provider: UsageProviderKind; readonly dir: string }[],
    progress: UsageReadProgress,
  ) {
    const finishedAtMs = yield* Clock.currentTimeMillis;
    const repeatedInputGaps: readonly UsageRepeatedInputCoverageGap[] = [
      {
        reason: "unattributed",
        count: 1,
        message: "Repeated-input attribution is partial because its response budget expired.",
      },
    ];
    const repeatedInput = !includeRepeatedInput(input)
      ? undefined
      : (progress.repeatedInput?.(repeatedInputGaps) ??
        mapRepeatedInputSummary(
          aggregateRepeatedInputObservations([], {
            rates,
            dayAt: makeDayFormatter(input.timeZone),
            coverageGaps: repeatedInputGaps,
          }),
        ));
    if (progress.ordinarySummary !== undefined)
      return {
        ...progress.ordinarySummary,
        readAt: DateTime.formatIso(DateTime.makeUnsafe(finishedAtMs)),
        scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
        ...(repeatedInput === undefined ? {} : { repeatedInput }),
      } satisfies UsageSummary;
    const selectedProviders = input.providers === undefined ? null : new Set(input.providers);
    const completedSources = progress.sources;
    const completedPaths = new Set(
      completedSources.map(
        (source) => `${source.fingerprint.provider}\u0000${source.fingerprint.resolvedHomePath}`,
      ),
    );
    const unfinishedSources = dirs
      .filter(
        ({ provider }) =>
          (input.quotaIntervals === undefined || provider === (input.quotaProvider ?? "codex")) &&
          (selectedProviders === null || selectedProviders.has(provider)),
      )
      .filter(({ provider, dir }) => !completedPaths.has(`${provider}\u0000${dir}`))
      .map(
        ({ provider, dir }) =>
          (progress.pendingSources.find(
            (source) =>
              source.fingerprint.provider === provider &&
              source.fingerprint.resolvedHomePath === dir,
          ) ?? {
            fingerprint: {
              hostId: NodeOS.hostname(),
              provider,
              resolvedHomePath: dir,
              volumeId: "",
            },
            status: "partial" as const,
            scannedFiles: 0,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 0,
            message:
              "Usage is partial because its response budget expired before this source finished.",
          }) satisfies UsageSource,
      );
    const clientContractVersion = input.clientContractVersion ?? 5;
    const supportsOpenCode = clientContractVersion >= 6;
    const supportsImports = clientContractVersion >= 7;
    const supportsProvider = (provider: UsageProviderKind) =>
      (provider !== "opencode" || supportsOpenCode) &&
      ((provider !== "chatgpt" && provider !== "aistudio") || supportsImports);
    const buckets = progress.aggregator?.finish().buckets ?? [];
    return {
      contractVersion: supportsImports ? USAGE_CONTRACT_VERSION : supportsOpenCode ? 6 : 5,
      readAt: DateTime.formatIso(DateTime.makeUnsafe(finishedAtMs)),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: buckets.filter((bucket) => supportsProvider(bucket.provider)),
      sources: [...completedSources, ...unfinishedSources].filter((source) =>
        supportsProvider(source.fingerprint.provider),
      ),
      pricing: pricing(),
      ...(repeatedInput === undefined ? {} : { repeatedInput }),
      ...(progress.quotaHistory === undefined ? {} : { quotaHistory: progress.quotaHistory }),
      ...(progress.providerQuotaHistories === undefined
        ? {}
        : { providerQuotaHistories: progress.providerQuotaHistories }),
      ...(input.quotaIntervals === undefined
        ? {}
        : {
            quotaCosts: progress.quotaCosts,
            quotaCostSnapshots: quotaCostLedger.filter((row) =>
              input.quotaIntervals!.some((interval) => interval.id === row.intervalId),
            ),
          }),
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  const readSummary: UsageService["Service"]["readSummary"] = Effect.fn("UsageService.readSummary")(
    function* (input: UsageSummaryInput) {
      const startedAtMs = yield* Clock.currentTimeMillis;
      let resolvedDirs: readonly { readonly provider: UsageProviderKind; readonly dir: string }[] =
        [];
      const progress: UsageReadProgress = {
        sources: [],
        pendingSources: [],
        quotaCosts: [],
        quotaHistory: undefined,
        providerQuotaHistories: undefined,
        aggregator: undefined,
        ordinarySummary: undefined,
        repeatedInput: undefined,
      };
      let ownedResult:
        | { key: string; result: Deferred.Deferred<Exit.Exit<UsageSummary, UsageReadError>, never> }
        | undefined;
      return yield* Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          if (input.sinceDay > input.untilDay) {
            return yield* new UsageReadError({
              reason: "invalidWindow",
              detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
            });
          }
          if (input.quotaHistoryOnly) return yield* readSummaryUnlocked(input, undefined, progress);
          yield* ensureCachedRates;
          const context = yield* resolveReadContext();
          resolvedDirs = context.dirs;
          // Establish source identities before waiting for a scan so saved interval
          // calculations remain usable when this request reaches its deadline.
          const sources = yield* Effect.forEach(
            context.dirs.filter(
              ({ provider }) =>
                (input.quotaIntervals === undefined ||
                  provider === (input.quotaProvider ?? "codex")) &&
                (input.providers === undefined || input.providers.includes(provider)),
            ),
            Effect.fnUntraced(function* ({ provider, dir }) {
              const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
              const exists = yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false));
              return {
                fingerprint: {
                  hostId: NodeOS.hostname(),
                  provider,
                  resolvedHomePath: dir,
                  volumeId,
                },
                status: exists ? ("partial" as const) : ("missing" as const),
                scannedFiles: 0,
                skippedFiles: 0,
                malformedRecords: 0,
                distinctSessions: 0,
                message: exists
                  ? "Usage is partial because its response budget expired before this source finished."
                  : "No transcript directory on this environment.",
              };
            }),
            { concurrency: 8 },
          );
          progress.pendingSources.push(...sources);
          const key = repeatedAwareSummaryCacheKey(input, context.settings.usagePriceOverrides);
          if (!input.refresh) {
            const cached = summaryCache.get(key, yield* Clock.currentTimeMillis);
            if (cached !== undefined) return cached;
          }
          if (!input.includeQuotaHistory) {
            const existing = inFlightSummaries.get(key);
            if (existing !== undefined) {
              const exit = yield* Deferred.await(existing);
              if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
              return exit.value;
            }
            const shared = Deferred.makeUnsafe<Exit.Exit<UsageSummary, UsageReadError>>();
            inFlightSummaries.set(key, shared);
            ownedResult = { key, result: shared };
          }
          const summary = yield* scanSemaphore.withPermits(1)(
            readSummaryUnlocked(input, context, progress).pipe(
              Effect.ensuring(Effect.sync(() => scanStore.release())),
            ),
          );
          if (
            summary.sources.length > 0 &&
            summary.sources.every((source) => source.status === "missing")
          ) {
            summaryCache.set(key, yield* Clock.currentTimeMillis, summary);
          }
          return summary;
        }).pipe(Effect.timeoutOption(MAX_USAGE_READ_DURATION_MS));
        if (Option.isSome(result)) return result.value;
        if (resolvedDirs.length === 0) {
          return yield* new UsageReadError({
            reason: "scanFailed",
            detail: "Usage response budget expired before source coverage could be established.",
          });
        }
        return yield* partialSummaryAtDeadline(input, startedAtMs, resolvedDirs, progress);
      }).pipe(
        Effect.onExit((completed) => {
          if (ownedResult === undefined) return Effect.void;
          const { key, result } = ownedResult;
          return Effect.sync(() => inFlightSummaries.delete(key)).pipe(
            Effect.andThen(Deferred.succeed(result, completed)),
          );
        }),
      );
    },
  );

  const readReport = Effect.fn("UsageService.readReport")(function* (input: UsageReportInput) {
    if (input.mode === "prompts") {
      yield* Effect.try({
        try: () => validatePromptUsageInput(input),
        catch: () =>
          new UsageReadError({
            reason: "invalidWindow",
            detail: "Invalid prompt usage window or unsupported filter.",
          }),
      });
      const accumulator = new PromptUsageAccumulator(input);
      const projection = yield* Effect.serviceOption(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      );
      const query = Option.isSome(projection)
        ? projection.value.listPromptUsageMessages
        : undefined;
      if (Option.isNone(projection) || query === undefined) {
        accumulator.reasons.add("projection-unavailable");
        return accumulator.report(DateTime.formatIso(yield* DateTime.now), true);
      }
      const startedAt = yield* Clock.currentTimeMillis;
      const readSequence = () =>
        projection.value.getSnapshotSequence().pipe(
          Effect.map((state) => state.snapshotSequence),
          Effect.catchCause(() => Effect.succeed(null)),
        );
      const initialSequence = yield* readSequence();
      const { sinceTime, untilTime } = promptUsageTimeBounds(input);
      let beforeCreatedAt = untilTime;
      let beforeMessageId = "";
      while (true) {
        const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
        if (elapsedMs >= 3000) {
          accumulator.reasons.add("read-deadline");
          break;
        }
        const rows = yield* query({ sinceTime, untilTime, beforeCreatedAt, beforeMessageId }).pipe(
          Effect.timeout(Duration.millis(3000 - elapsedMs)),
          Effect.catchCause(() => {
            accumulator.reasons.add("projection-read-failed");
            return Effect.succeed([]);
          }),
        );
        for (const row of rows) {
          if (
            accumulator.examinedMessages >= 5000 ||
            accumulator.textCharacters + row.text.length > 4 * 1024 * 1024
          ) {
            accumulator.reasons.add("read-limit");
            break;
          }
          accumulator.add(row);
        }
        if (rows.length < 32 || accumulator.reasons.has("read-limit")) break;
        const last = rows[rows.length - 1]!;
        beforeCreatedAt = last.createdAt;
        beforeMessageId = last.messageId;
      }
      const finalSequence = yield* readSequence();
      if (initialSequence === null || finalSequence === null) {
        accumulator.reasons.add("projection-sequence-unavailable");
      } else if (initialSequence !== finalSequence) {
        accumulator.reasons.add("projection-changed");
      }
      return accumulator.report(
        DateTime.formatIso(yield* DateTime.now),
        accumulator.examinedMessages === 0 && accumulator.reasons.has("projection-read-failed"),
      );
    }
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    const settings = yield* readSettings;
    if (input.mode === "pricing") {
      yield* ensureRates(input.refresh === true);
      const now = yield* DateTime.now;
      const summary: UsageSummary = {
        ...emptyUsageSummary(input),
        readAt: DateTime.formatIso(now),
        pricing: pricing(),
      };
      return projectUsageReport(
        summary,
        input,
        makeUsageReportCalculation(summary.pricing, settings.usagePriceOverrides),
      );
    }

    const summaryInput: UsageSummaryInput = {
      clientContractVersion: USAGE_CONTRACT_VERSION,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      timeZone: input.timeZone,
      ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
      ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
      ...(input.sinceTime === undefined ? {} : { sinceTime: input.sinceTime }),
      ...(input.untilTime === undefined ? {} : { untilTime: input.untilTime }),
      ...(input.providers === undefined ? {} : { providers: input.providers }),
      ...(input.mode === "runs"
        ? {
            groupBy: "run" as const,
            ...(input.runIds === undefined ? {} : { runIds: input.runIds }),
          }
        : {}),
      ...(input.mode !== "quota"
        ? {}
        : input.quotaIntervals === undefined
          ? { quotaHistoryOnly: true }
          : { includeQuotaHistory: true, quotaIntervals: input.quotaIntervals }),
    };
    const summary = yield* readSummary(summaryInput);
    const report = projectUsageReport(
      summary,
      input,
      makeUsageReportCalculation(summary.pricing, settings.usagePriceOverrides),
    );
    if (report.mode !== "runs" || (report.runs.length === 0 && report.dailyRuns.length === 0))
      return report;

    const projection = yield* Effect.serviceOption(ProjectionSnapshotQuery.ProjectionSnapshotQuery);
    if (
      Option.isNone(projection) ||
      projection.value.findThreadMappingsByProviderSessionIds === undefined
    ) {
      return report;
    }

    const runIds = [...new Set([...report.runs, ...report.dailyRuns].map((run) => run.runId))];
    const lookupIds = runIds.slice(0, 512);
    const lookupSet = new Set(lookupIds);
    const mappings = yield* projection.value.findThreadMappingsByProviderSessionIds(lookupIds).pipe(
      Effect.map((rows) => ({ rows, failed: false as const })),
      Effect.catchCause(() => Effect.succeed({ rows: [], failed: true as const })),
    );
    const reportRunKeys = new Set(
      [...report.runs, ...report.dailyRuns].map((run) => `${run.provider}\u0000${run.runId}`),
    );
    const threadsByRun = new Map<string, Set<string>>();
    const ambiguousKeys = new Set<string>();
    for (const mapping of mappings.rows) {
      const provider = mapping.providerName === "claudeAgent" ? "claude" : mapping.providerName;
      const key = `${provider}\u0000${mapping.providerSessionId}`;
      if (!reportRunKeys.has(key) || mapping.threadId.length > 512) continue;
      const threadIds = threadsByRun.get(key) ?? new Set<string>();
      threadIds.add(mapping.threadId);
      threadsByRun.set(key, threadIds);
      if (mapping.threadCount > 1) ambiguousKeys.add(key);
    }
    const mapRun = <T extends { readonly provider: string; readonly runId: string }>(run: T) => {
      const key = `${run.provider}\u0000${run.runId}`;
      const threadIds = threadsByRun.get(key);
      const unavailable = mappings.failed || !lookupSet.has(run.runId);
      const ambiguous = ambiguousKeys.has(key) || (threadIds?.size ?? 0) > 1;
      return {
        ...run,
        threadId: !unavailable && !ambiguous && threadIds?.size === 1 ? [...threadIds][0]! : null,
        threadMapping: unavailable
          ? ("unavailable" as const)
          : threadIds === undefined
            ? ("missing" as const)
            : ambiguous
              ? ("ambiguous" as const)
              : ("matched" as const),
      };
    };
    return {
      ...report,
      runs: report.runs.map(mapRun),
      dailyRuns: report.dailyRuns.map(mapRun),
      threadMappingStatus:
        mappings.failed || runIds.length > lookupIds.length ? "partial" : "complete",
    };
  });

  return {
    readSummary,
    readReport: readReport as UsageService["Service"]["readReport"],
    refreshRates,
  } as const;
});

export const layer = Layer.effect(UsageService, make);
