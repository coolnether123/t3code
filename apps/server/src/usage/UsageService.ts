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
import * as NodeOS from "node:os";

import {
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
  type UsageQuotaCost,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { parseRateTable, type RateTable } from "./usagePricing.ts";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
  selectTranscriptFilesForScan,
  transcriptCursorIsLineBoundary,
  type TranscriptFile,
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  decodeScanCoverage,
  dedupeWithinFile,
  encodeScanCache,
  planTranscriptScan,
  pruneScanCache,
  type ScanCache,
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
import { UsageSummaryCache, usageSummaryCacheKey } from "./usageSummaryCache.ts";
import {
  QuotaCostAccumulator,
  readQuotaHistory,
  validQuotaIntervals,
} from "./usageQuotaHistory.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

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

/** Range switches inside this span reuse the inventory from the previous read. */
const INCREMENTAL_SCAN_TTL_MS = 15 * 1000;

/** Full audits catch deleted history without putting a tree walk on every request. */
const FULL_SCAN_INTERVAL_MS = 15 * 60 * 1000;

/** Matches the client query TTL while deduplicating requests across clients. */
const SUMMARY_CACHE_TTL_MS = 60 * 1000;
const MAX_SUMMARY_CACHE_ENTRIES = 16;

/** On-disk shape of the rate snapshot. */
const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);

/** The scan cache is narrowed by hand in `usageScanCache`, so JSON is enough here. */
const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeScanCacheFile = Schema.encodeEffect(ScanCacheJson);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
  }
>()("t3/usage/UsageService") {}

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
          fetchedAt: null,
          knownModels: 0,
        },
        scanDurationMs: 0,
      }),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const scanSemaphore = yield* Semaphore.make(1);

  const fileCache: ScanCache = new Map();
  const scanCoverage = new Map<string, ScanCoverage>();
  const recentScanAt = new Map<string, number>();
  const summaryCache = new UsageSummaryCache(SUMMARY_CACHE_TTL_MS, MAX_SUMMARY_CACHE_ENTRIES);
  let cacheDirty = false;

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing.
   */
  const ensureRates = Effect.fn("UsageService.ensureRates")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < RATES_TTL_MS) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap((raw) => decodeRatesCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk !== null) {
        const parsed = parseRateTable(fromDisk.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = fromDisk.fetchedAtMs;
          ratesStatus = "cached";
          if (now - fromDisk.fetchedAtMs < RATES_TTL_MS) return;
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
    ratesFetchedAtMs = now;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(ratesCachePath, serialized)),
      Effect.catchCause(() => Effect.void),
    );
  });

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
  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* () {
    // A settings failure must surface as an error: swallowing it here would
    // present "zero usage from every provider" as a valid answer.
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            // Bounded description; the squashed failure travels as the cause.
            // Squashed, not the Cause tree: a full tree in a Defect field is
            // the unbounded wire payload the bounded detail exists to avoid.
            detail: "Server settings could not be read.",
            cause: Cause.squash(cause),
          }),
      ),
    );

    const claudeHome = yield* resolveClaudeHomePath(settings.providers.claudeAgent);
    const claudeDir = yield* resolveClaudeTranscriptDir(claudeHome);
    const codexLayout = yield* resolveCodexHomeLayout(settings.providers.codex);
    const codexHome = codexLayout.sharedHomePath;
    const geminiHome = path.join(NodeOS.homedir(), ".gemini");
    const openCodeHome = path.join(NodeOS.homedir(), ".local", "share", "opencode");

    return [
      { provider: "claude" as const, dir: claudeDir },
      { provider: "codex" as const, dir: path.join(codexHome, "sessions") },
      { provider: "codex" as const, dir: path.join(codexHome, "archived_sessions") },
      { provider: "gemini" as const, dir: path.join(geminiHome, "tmp") },
      { provider: "gemini" as const, dir: path.join(geminiHome, "antigravity", "brain") },
      { provider: "opencode" as const, dir: openCodeHome },
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

  const persistScanCache = Effect.fn("UsageService.persistScanCache")(function* () {
    if (!cacheDirty) return;
    // Cleared only after the write lands, so a failed persist is retried on
    // the next scan instead of leaving disk permanently stale.
    yield* encodeScanCacheFile(encodeScanCache(fileCache, [...scanCoverage.values()])).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: scanCachePath, contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      ),
      Effect.map(() => {
        cacheDirty = false;
      }),
      // A cache we cannot write is a slower next start, not a failed read.
      Effect.catchCause(() => Effect.void),
    );
  });

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
      cacheDirty = true;
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
      input.includeQuotaHistory || input.quotaHistoryOnly
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
          fetchedAt: null,
          knownModels: 0,
        },
        scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
        quotaHistory,
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
    const dirs = yield* resolveTranscriptDirs().pipe(Effect.provideService(Path.Path, path));
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
    });

    const sources: UsageSource[] = [];
    for (const { provider, dir } of dirs) {
      // Reset comparisons use the main Codex quota, never other providers.
      if (input.quotaIntervals !== undefined && provider !== "codex") continue;
      const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));

      if (!exists) {
        sources.push({
          fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
          status: "missing",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message: "No transcript directory on this environment.",
        });
        continue;
      }

      const coverageKey = `${provider}\u0000${dir}`;
      const coverage = scanCoverage.get(coverageKey);
      const lastRecentScanAt = recentScanAt.get(coverageKey) ?? 0;
      const { hasCurrentCoverage, shouldRefresh, scanStartMs } = planTranscriptScan({
        coverage,
        windowStartMs,
        nowMs: startedAtMs,
        lastRecentScanAtMs: lastRecentScanAt,
        incrementalScanTtlMs: input.refresh ? 0 : INCREMENTAL_SCAN_TTL_MS,
        recentTranscriptWindowMs: RECENT_TRANSCRIPT_WINDOW_MS,
        fullScanIntervalMs: FULL_SCAN_INTERVAL_MS,
      });
      const discoveredFiles = shouldRefresh
        ? yield* Effect.promise(() => listTranscriptFiles(dir, scanStartMs, provider))
        : [];
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
          return { ...file, startByte: warm ? file.size : appendable ? cached.size : 0 };
        }),
        { concurrency: 16 },
      );
      const selection = selectTranscriptFilesForScan(
        plannedFiles,
        (file) => file.size - file.startByte,
        MAX_COLD_SCAN_BYTES_PER_SOURCE,
      );

      if (shouldRefresh) {
        const pruned = pruneScanCache(fileCache, {
          livePaths: new Set(discoveredFiles.map((file) => file.path)),
          walkedRoots: [dir],
          windowStartMs: scanStartMs,
          retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        });
        if (pruned > 0) cacheDirty = true;
      }
      let scannedFiles = 0;
      let skippedFiles = selection.deferredFiles;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();
      const quota = new QuotaCostAccumulator(provider === "codex" ? quotaIntervals : [], rates);

      for (const file of selection.files) {
        const records = yield* readFileRecords(
          file.path,
          file.size,
          file.mtimeMs,
          provider,
          file.startByte,
        );
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
          cacheDirty = true;
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
            : null,
      });
    }

    const pruned = pruneScanCache(fileCache, {
      livePaths: new Set(),
      walkedRoots: [],
      windowStartMs,
      retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    });
    if (pruned > 0) cacheDirty = true;
    yield* persistScanCache();

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;
    const supportsOpenCode = (input.clientContractVersion ?? 5) >= 6;

    return {
      contractVersion: supportsOpenCode ? USAGE_CONTRACT_VERSION : 5,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: supportsOpenCode
        ? aggregated.buckets
        : aggregated.buckets.filter((bucket) => bucket.provider !== "opencode"),
      sources: supportsOpenCode
        ? sources
        : sources.filter((source) => source.fingerprint.provider !== "opencode"),
      pricing: {
        status: ratesStatus,
        source: LITELLM_RATES_URL,
        fetchedAt:
          ratesFetchedAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
        knownModels: rates.size,
      },
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
      ...(quotaHistory === undefined ? {} : { quotaHistory }),
      ...(input.quotaIntervals === undefined ? {} : { quotaCosts }),
    } satisfies UsageSummary;
  });

  // A cache miss is decided from mutable per-file state. Serializing summary
  // scans makes that decision single-flight: a second window waits for the
  // first scan to persist its newly warm files instead of parsing them again.
  const readSummary: UsageService["Service"]["readSummary"] = (input) =>
    input.quotaHistoryOnly
      ? readSummaryUnlocked(input)
      : scanSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const startedAtMs = yield* Clock.currentTimeMillis;
            const key = usageSummaryCacheKey(input);
            const cached = input.refresh ? undefined : summaryCache.get(key, startedAtMs);
            if (cached !== undefined) return cached;

            const summary = yield* readSummaryUnlocked(input);
            if (summary.sources.every((source) => source.status !== "partial")) {
              const finishedAtMs = yield* Clock.currentTimeMillis;
              summaryCache.set(key, finishedAtMs, summary);
            }
            return summary;
          }),
        );

  return { readSummary } as const;
});

export const layer = Layer.effect(UsageService, make);
