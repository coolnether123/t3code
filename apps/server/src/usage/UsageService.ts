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
  type UsageRepeatedInputSummary,
  type UsageRepeatedInputBreakdown,
  type UsageRepeatedInputItem,
  type UsageRepeatedInputModelCost,
  type UsageDay,
  type UsageQuotaCost,
  type ServerSettings as ServerSettingsValue,
  type UsagePricing,
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
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import {
  codexIsolatedHomePath,
  resolveCodexHomeLayout,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { makeDayFormatter, UsageAggregator } from "./usageAggregation.ts";
import { createOverrideRateTable, parseRateTable, type RateTable } from "./usagePricing.ts";
import { UsageSummaryCache, usageSummaryCacheKey } from "./usageSummaryCache.ts";
import {
  listTranscriptFiles,
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
  decodeScanCache,
  decodeScanCoverage,
  dedupeWithinFile,
  encodeScanCache,
  planTranscriptScan,
  pruneScanCache,
  type ScanCache,
  type CachedFile,
  type ScanCoverage,
} from "./usageScanCache.ts";
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

/** Files changed in this span are checked between complete directory audits. */
const RECENT_TRANSCRIPT_WINDOW_MS = 48 * 60 * 60 * 1000;

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
    modelCosts: item.modelCosts.map((modelCost): UsageRepeatedInputModelCost => ({
      // Unknown model identity is retained under a stable display key. Its
      // nullable price status remains unpriced and is never treated as free.
      model: modelCost.model ?? "unknown",
      directTokens: modelCost.directTokens,
      estimatedApiCostUsd: repeatedInputPrice(modelCost.estimatedApiCostUsd, modelCost.priceStatus),
      priceStatus: modelCost.priceStatus,
      occurrences: modelCost.occurrences,
    })),
    breakdowns: item.breakdowns.map(mapRepeatedInputBreakdown),
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
const encodeScanCacheFile = Schema.encodeEffect(ScanCacheJson);
const encodeRateDocument = Schema.encodeSync(ScanCacheJson);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
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

/** Empty summary, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({
    readSummary: (input) =>
      Effect.succeed({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: {
          status: "unavailable",
          source: LITELLM_RATES_URL,
          revision: null,
          fetchedAt: null,
          knownModels: 0,
        },
        scanDurationMs: 0,
      }),
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

  const fileCache: ScanCache = new Map();
  const scanCoverage = new Map<string, ScanCoverage>();
  const recentScanAt = new Map<string, number>();
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
  let cacheDirty = false;
  let cacheRevision = 0;

  // A scan response must not wait for the complete JSON cache to be encoded
  // and atomically replaced. The cache is an optimization; the in-memory
  // records already used to build the response are authoritative for this
  // process. Revisions let the worker tell whether another scan made changes
  // while it was serializing or writing its snapshot.
  const markCacheDirty = () => {
    cacheDirty = true;
    cacheRevision += 1;
  };

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
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

  const ensureRates = (force = false) =>
    ratesLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
        if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;

        if (ratesFetchedAtMs === null) {
          const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
            Effect.flatMap((raw) => decodeRatesCache(raw)),
            Effect.catchCause(() => Effect.succeed(null)),
          );
          if (fromDisk !== null) {
            const parsed = parseRateTable(fromDisk.document);
            if (parsed.size > 0) {
              rates = parsed;
              const revisionDocument = encodeRateDocument(fromDisk.document);
              ratesRevision = NodeCrypto.createHash("sha256")
                .update(revisionDocument)
                .digest("hex");
              ratesFetchedAtMs = fromDisk.fetchedAtMs;
              ratesStatus = "cached";
              if (now - fromDisk.fetchedAtMs < maxAgeMs) return;
            }
          }
        }

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
          Effect.flatMap((serialized) => fileSystem.writeFileString(ratesCachePath, serialized)),
          Effect.catchCause(() => Effect.void),
        );
      }),
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
      return nestedExists ? nested : path.join(homePath, "projects");
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

  /**
   * Loads once under the scan semaphore, marking completion only after the read.
   * A cancelled first reader leaves the next request free to load the cache.
   */
  let scanCacheLoaded = false;
  const ensureScanCacheLoaded = Effect.gen(function* () {
    if (scanCacheLoaded) return;
    const document = yield* fileSystem.readFileString(scanCachePath).pipe(
      Effect.flatMap((raw) => decodeScanCacheFile(raw)),
      Effect.orElseSucceed(() => null),
    );
    if (document !== null) {
      for (const [path, entry] of decodeScanCache(document)) fileCache.set(path, entry);
      for (const entry of decodeScanCoverage(document)) {
        scanCoverage.set(`${entry.provider}\u0000${entry.rootPath}`, entry);
      }
    }
    scanCacheLoaded = true;
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

  const persistScanCacheOnce = Effect.fn("UsageService.persistScanCache")(function* () {
    if (!cacheDirty) return true;
    const revision = cacheRevision;
    // Cleared only after the write lands, so a failed persist is retried on
    // the next scan instead of leaving disk permanently stale. If a newer
    // scan changed the maps meanwhile, its revision remains dirty and the
    // worker publishes that newer snapshot next.
    return yield* encodeScanCacheFile(encodeScanCache(fileCache, [...scanCoverage.values()])).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          writeFileStringAtomically({ filePath: scanCachePath, contents }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        ),
      ),
      Effect.map(() => {
        if (cacheRevision === revision) cacheDirty = false;
        return true;
      }),
      // A cache we cannot write is a slower next start, not a failed read.
      Effect.catchCause(() => Effect.succeed(false)),
    );
  });
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
      yield* persistScanCacheOnce();
    }
  });
  // Keep exactly one consumer alive for the service lifetime. Queue wakes are
  // deliberately lossy: the revision check in persistScanCacheOnce means a
  // single wake is enough to publish all changes made before it runs.
  const persistWorker = yield* Effect.forkIn(runPersistWorker, serviceScope, {
    startImmediately: true,
  });
  yield* Effect.addFinalizer(() =>
    Effect.uninterruptible(
      Scope.close(serviceScope, Exit.void).pipe(
        Effect.andThen(Fiber.await(persistWorker)),
        Effect.andThen(persistQuotaCostLedgerOnce()),
        Effect.andThen(persistScanCacheOnce()),
        Effect.ignore,
      ),
    ),
  );

  /** Parses one transcript, reusing the cached result when it is unchanged. */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    startByte: number,
  ): Effect.Effect<readonly UsageRecord[]> =>
    Effect.gen(function* () {
      const cached = fileCache.get(filePath);
      // Provider is part of the identity: if both providers were ever pointed
      // at one directory, a hit parsed by the other parser must not be reused.
      if (
        cached &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider
      ) {
        return cached.records;
      }

      const appendable = cached !== undefined && startByte > 0;
      const parsed = yield* Effect.promise(() =>
        readTranscriptRecords(filePath, provider, {
          startByte,
          endByte: size - 1,
          ...(appendable && provider === "codex" && cached?.codexState !== undefined
            ? { codexState: cached.codexState }
            : {}),
        }),
      );
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null) return [];
      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The aggregator still runs the cross-file dedupe pass.
      const records = dedupeWithinFile([
        ...(appendable && cached !== undefined ? cached.records : []),
        ...parsed.records,
      ]);

      fileCache.set(filePath, {
        size,
        mtimeMs,
        provider,
        records,
        ...(parsed.codexState === undefined ? {} : { codexState: parsed.codexState }),
      });
      markCacheDirty();
      return records;
    });

  const readSummaryUnlocked = Effect.fn("UsageService.readSummaryUnlocked")(function* (
    input: UsageSummaryInput,
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
        quotaCostSnapshots:
          input.quotaIntervals === undefined
            ? quotaCostLedger
            : quotaCostLedger.filter((row) =>
                input.quotaIntervals!.some((interval) => interval.id === row.intervalId),
              ),
      } satisfies UsageSummary;
    }
    const quotaCosts: UsageQuotaCost[] = [];
    yield* ensureRates();
    yield* ensureScanCacheLoaded;
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
    const settings = yield* readSettings;
    const dirs = yield* resolveTranscriptDirs(settings).pipe(
      Effect.provideService(Path.Path, path),
    );
    const repeatedInputEnabled = includeRepeatedInput(input);
    const repeatedInputObservations: RepeatedInputObservation[] = [];
    const repeatedInputGaps: UsageRepeatedInputCoverageGap[] = [];
    let repeatedInputCatalogForScan: RepeatedInputCatalog | null = null;
    const repeatedInputProviderSelected =
      input.providers === undefined || input.providers.includes("codex");
    if (repeatedInputEnabled && repeatedInputProviderSelected) {
      const inputRoots = dirs
        .filter(({ provider }) => provider === "codex")
        .flatMap(({ dir }) => {
          const home = path.dirname(dir);
          return [path.join(home, "skills"), path.join(home, "plugins")];
        });
      repeatedInputCatalogForScan = yield* ensureRepeatedInputCatalog(
        inputRoots,
        input.refresh === true,
      );
      repeatedInputGaps.push(...repeatedInputDiscoveryGaps);
    }
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
      ...(input.providers === undefined ? {} : { providers: input.providers }),
      ...(input.sessionIds === undefined ? {} : { sessionIds: input.sessionIds }),
      ...(input.turnIds === undefined ? {} : { turnIds: input.turnIds }),
      ...(input.groupBy === undefined ? {} : { groupBy: input.groupBy }),
    });

    const sources: UsageSource[] = [];
    const selectedProviders = input.providers === undefined ? null : new Set(input.providers);
    const selectedSessionIds = input.sessionIds === undefined ? null : new Set(input.sessionIds);
    const selectedTurnIds = input.turnIds === undefined ? null : new Set(input.turnIds);
    const activeDirs = dirs.filter(
      ({ provider }) =>
        (input.quotaIntervals === undefined || provider === "codex") &&
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
        const coverage = scanCoverage.get(coverageKey);
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
        const discoveredFiles = plan.shouldRefresh
          ? yield* Effect.promise(() => listTranscriptFiles(dir, plan.scanStartMs, provider))
          : [];
        return {
          provider,
          dir,
          volumeId,
          exists: true as const,
          coverageKey,
          discoveredFiles,
          ...plan,
        };
      }),
      { concurrency: 8 },
    );

    for (const source of plannedSources) {
      const { provider, dir, volumeId } = source;
      if (!source.exists) {
        sources.push({
          fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
          status: "missing",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message:
            provider === "chatgpt" || provider === "aistudio"
              ? "Configured chat archive directory was not found on this environment."
              : "No transcript directory on this environment.",
        });
        continue;
      }

      const { coverageKey, discoveredFiles, hasCurrentCoverage, shouldRefresh, scanStartMs } =
        source;
      const filesByPath = new Map<string, TranscriptFile>();

      if (hasCurrentCoverage) {
        for (const [filePath, entry] of fileCache) {
          if (entry.provider !== provider || entry.mtimeMs < windowStartMs) continue;
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
      }
      for (const file of discoveredFiles) filesByPath.set(file.path, file);
      const files = [...filesByPath.values()];
      const plannedFiles = yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (file) {
          const cached = fileCache.get(file.path);
          const warm =
            cached !== undefined &&
            cached.size === file.size &&
            cached.mtimeMs === file.mtimeMs &&
            cached.provider === provider;
          const appendable =
            !warm &&
            cached !== undefined &&
            cached.provider === provider &&
            file.size > cached.size &&
            (provider === "claude" || (provider === "codex" && cached.codexState !== undefined)) &&
            (yield* Effect.promise(() => transcriptCursorIsLineBoundary(file.path, cached.size)));
          const startByte = warm ? file.size : appendable ? cached.size : 0;
          const parserMatches = cached?.repeatedInputVersion === REPEATED_INPUT_CACHE_VERSION;
          const repeatedInputWarm =
            repeatedInputEnabled &&
            provider === "codex" &&
            warm &&
            parserMatches &&
            cached?.repeatedInputObservations !== undefined;
          const repeatedInputAppendable =
            repeatedInputEnabled &&
            provider === "codex" &&
            !warm &&
            parserMatches &&
            cached !== undefined &&
            cached.provider === provider &&
            cached.repeatedInputObservations !== undefined &&
            file.size > cached.size &&
            cached.prefixFingerprint !== undefined &&
            (yield* Effect.promise(() =>
              transcriptAppendIsSafe(file.path, {
                offset: cached.size,
                prefixFingerprint: cached.prefixFingerprint!,
              }),
            ));
          const repeatedInputStartByte =
            !repeatedInputEnabled || provider !== "codex"
              ? file.size
              : repeatedInputWarm
                ? file.size
                : repeatedInputAppendable
                  ? cached!.size
                  : 0;
          return {
            ...file,
            startByte,
            repeatedInputStartByte,
            repeatedInputWarm,
            repeatedInputAppendable,
          };
        }),
        { concurrency: 16 },
      );
      const selection = selectTranscriptFilesForScan(
        plannedFiles,
        (file) => Math.max(file.size - file.startByte, file.size - file.repeatedInputStartByte),
        MAX_COLD_SCAN_BYTES_PER_SOURCE,
      );
      if (repeatedInputEnabled && provider === "codex" && selection.deferredFiles > 0) {
        // The ordinary Usage scan may intentionally defer cold files to keep a
        // long-range request responsive. Repeated-input attribution must make
        // that boundary visible instead of presenting a complete-looking
        // aggregate from the subset that happened to fit the budget.
        repeatedInputGaps.push({
          reason: "unattributed",
          count: selection.deferredFiles,
          message:
            "Some Codex transcript files were deferred before repeated-input attribution could inspect them.",
        });
      }

      if (shouldRefresh) {
        const pruned = pruneScanCache(fileCache, {
          livePaths: new Set(discoveredFiles.map((file) => file.path)),
          walkedRoots: [dir],
          windowStartMs: scanStartMs,
          retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        });
        if (pruned > 0) markCacheDirty();
      }
      let scannedFiles = 0;
      let skippedFiles = selection.deferredFiles;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();
      const quota = new QuotaCostAccumulator(
        provider === "codex" ? quotaIntervals : [],
        rates,
        createOverrideRateTable(settings.usagePriceOverrides),
      );

      for (const file of selection.files) {
        const cachedBefore = fileCache.get(file.path);
        const records = yield* readFileRecords(
          file.path,
          file.size,
          file.mtimeMs,
          provider,
          file.startByte,
        );
        if (repeatedInputEnabled && provider === "codex") {
          const repeatedWarm = file.repeatedInputWarm;
          const appendable = file.repeatedInputAppendable;
          let nextObservations = repeatedWarm ? cachedBefore?.repeatedInputObservations : undefined;
          let nextGaps = repeatedWarm ? cachedBefore?.repeatedInputGaps : undefined;
          if (!repeatedWarm) {
            const repeatedStartByte = file.repeatedInputStartByte;
            const parserState = appendable
              ? repeatedInputParserStateForCached(cachedBefore!, null, hostId)
              : undefined;
            const parsed = yield* Effect.promise(() =>
              readRepeatedInputRecords(file.path, {
                startByte: repeatedStartByte,
                endByte: file.size - 1,
                catalog: repeatedInputCatalogForScan ?? undefined,
                maxPayloadBytes: 4 * 1024 * 1024,
                project: null,
                environment: hostId,
                ...(parserState === undefined ? {} : { parserState }),
              }),
            );
            nextObservations =
              parsed === null
                ? []
                : appendable
                  ? dedupeRepeatedInputObservations([
                      ...(cachedBefore?.repeatedInputObservations ?? []),
                      ...parsed.observations,
                    ])
                  : dedupeRepeatedInputObservations(parsed.observations);
            nextGaps = parsed?.gaps ?? [
              {
                reason: "unavailable" as const,
                count: 1,
                message: "The Codex transcript could not be read for repeated-input attribution.",
              },
            ];
          }
          nextObservations = attachRepeatedInputUsage(nextObservations ?? [], records);
          repeatedInputObservations.push(...(nextObservations ?? []));
          repeatedInputGaps.push(...(nextGaps ?? []));
          const entry = fileCache.get(file.path);
          if (entry !== undefined && !repeatedWarm) {
            const prefixFingerprint = yield* Effect.promise(() =>
              readTranscriptPrefixFingerprint(file.path, file.size),
            );
            fileCache.set(file.path, {
              ...entry,
              ...(prefixFingerprint === null ? {} : { prefixFingerprint }),
              repeatedInputObservations: nextObservations ?? [],
              repeatedInputGaps: nextGaps ?? [],
              repeatedInputVersion: REPEATED_INPUT_CACHE_VERSION,
            });
            markCacheDirty();
          }
        } else if (repeatedInputEnabled && cachedBefore?.repeatedInputObservations !== undefined) {
          // Only Codex transcript payloads are currently attributable. Do not
          // accidentally expose observations from a provider that shares a path.
          repeatedInputObservations.push(...cachedBefore.repeatedInputObservations);
          repeatedInputGaps.push(...(cachedBefore.repeatedInputGaps ?? []));
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
        selection.deferredFiles === 0 &&
        selection.files.every((file) => {
          const cached = fileCache.get(file.path);
          return (
            cached !== undefined &&
            cached.size === file.size &&
            cached.mtimeMs === file.mtimeMs &&
            cached.provider === provider
          );
        });
      if (shouldRefresh && scanCompleted) {
        recentScanAt.set(coverageKey, startedAtMs);
        if (!hasCurrentCoverage) {
          scanCoverage.set(coverageKey, {
            provider,
            rootPath: dir,
            sinceMs: scanStartMs,
            scannedAtMs: startedAtMs,
          });
          markCacheDirty();
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
        status: selection.deferredFiles > 0 ? "partial" : "ok",
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message:
          selection.deferredFiles > 0
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

    const pruned = pruneScanCache(fileCache, {
      livePaths: new Set(),
      walkedRoots: [],
      windowStartMs,
      retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    });
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
    if (pruned > 0) markCacheDirty();
    // Cache persistence is derived work. Wake the permanent consumer without
    // making the response wait for JSON encoding or atomic replacement.
    yield* Queue.offer(persistQueue, undefined);

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;
    const repeatedDayAt = makeDayFormatter(input.timeZone);
    const repeatedInput = repeatedInputEnabled
      ? mapRepeatedInputSummary(
          aggregateRepeatedInputObservations(
            repeatedInputObservations.filter((observation) => {
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
              rates,
              priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
              dayAt: repeatedDayAt,
              coverageGaps: repeatedInputGaps,
            },
          ),
        )
      : undefined;
    const clientContractVersion = input.clientContractVersion ?? 5;
    const supportsOpenCode = clientContractVersion >= 6;
    const supportsImports = clientContractVersion >= 7;
    const supportsProvider = (provider: UsageProviderKind) =>
      (provider !== "opencode" || supportsOpenCode) &&
      ((provider !== "chatgpt" && provider !== "aistudio") || supportsImports);

    return {
      contractVersion: supportsImports ? USAGE_CONTRACT_VERSION : supportsOpenCode ? 6 : 5,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets.filter((bucket) => supportsProvider(bucket.provider)),
      sources: sources.filter((source) => supportsProvider(source.fingerprint.provider)),
      pricing: {
        status: ratesStatus,
        source: LITELLM_RATES_URL,
        revision: ratesRevision,
        fetchedAt:
          ratesFetchedAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
        knownModels: rates.size,
      },
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
      ...(repeatedInput === undefined ? {} : { repeatedInput }),
      ...(quotaHistory === undefined ? {} : { quotaHistory }),
      ...(input.quotaIntervals === undefined ? {} : { quotaCosts }),
      ...(input.quotaIntervals === undefined
        ? {}
        : {
            quotaCostSnapshots: quotaCostLedger.filter((row) =>
              input.quotaIntervals!.some((interval) => interval.id === row.intervalId),
            ),
          }),
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
    return includeRepeatedInput(input) ? `${base}\u0000repeatedInput=1` : base;
  };
  const readSummary: UsageService["Service"]["readSummary"] = (input) =>
    input.quotaHistoryOnly
      ? readSummaryUnlocked(input)
      : input.includeQuotaHistory
        ? Effect.gen(function* () {
            const settings = yield* readSettings;
            const key = repeatedAwareSummaryCacheKey(input, settings.usagePriceOverrides);
            if (!input.refresh) {
              const cached = summaryCache.get(key, yield* Clock.currentTimeMillis);
              if (cached !== undefined) return cached;
            }
            return yield* scanSemaphore.withPermits(1)(
              Effect.gen(function* () {
                if (!input.refresh) {
                  const cached = summaryCache.get(key, yield* Clock.currentTimeMillis);
                  if (cached !== undefined) return cached;
                }
                const summary = yield* readSummaryUnlocked(input);
                // A provider-backed result must be rebuilt so changed transcript
                // metadata can invalidate it. Empty-source history fixtures are
                // safe to reuse and keep history-only navigation inexpensive.
                if (summary.sources.every((source) => source.status === "missing")) {
                  summaryCache.set(key, yield* Clock.currentTimeMillis, summary);
                }
                return summary;
              }),
            );
          })
        : // Reject an inverted calendar window before joining the single-flight
          // map. Invalid input has no scan to share and must remain immediate.
          input.sinceDay > input.untilDay
          ? readSummaryUnlocked(input)
          : Effect.gen(function* () {
              const settings = yield* readSettings;
              const key = repeatedAwareSummaryCacheKey(input, settings.usagePriceOverrides);
              if (!input.refresh) {
                const cached = summaryCache.get(key, yield* Clock.currentTimeMillis);
                if (cached !== undefined) return cached;
              }

              const registration = yield* Effect.sync(() => {
                const existing = inFlightSummaries.get(key);
                if (existing !== undefined) return { existing } as const;
                const result = Deferred.makeUnsafe<Exit.Exit<UsageSummary, UsageReadError>>();
                inFlightSummaries.set(key, result);
                return { result } as const;
              });
              if ("existing" in registration) {
                const exit = yield* Deferred.await(registration.existing);
                if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
                return exit.value;
              }

              const result = registration.result;
              // Registration is synchronous, so concurrent callers cannot both
              // observe an empty map before the owner is installed.
              const exit = yield* scanSemaphore
                .withPermits(1)(readSummaryUnlocked(input))
                .pipe(
                  Effect.onExit((completed) =>
                    Effect.sync(() => inFlightSummaries.delete(key)).pipe(
                      Effect.andThen(Deferred.succeed(result, completed)),
                    ),
                  ),
                  Effect.exit,
                );
              if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
              if (exit.value.sources.every((source) => source.status === "missing")) {
                summaryCache.set(key, yield* Clock.currentTimeMillis, exit.value);
              }
              return exit.value;
            });

  return { readSummary, refreshRates } as const;
});

export const layer = Layer.effect(UsageService, make);
