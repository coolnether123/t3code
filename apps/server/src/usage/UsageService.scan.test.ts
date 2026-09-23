import * as Path from "effect/Path";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient } from "effect/unstable/http";
import { UsageDay, type UsageSummary } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { make } from "./UsageService.ts";
import { quotaCostLedgerKey } from "./usageQuotaCostLedger.ts";
import { encodeScanCache, type ScanCache } from "./usageScanCache.ts";
import { initialCodexScanState, type UsageRecord } from "./usageTranscripts.ts";
import {
  listTranscriptFilesBounded,
  readRepeatedInputRecords,
  readTranscriptRecords,
  transcriptCursorIsLineBoundary,
} from "./usageTranscriptReader.ts";

const files = [
  { path: "/fixture/large.jsonl", size: 200_000_040, mtimeMs: Date.parse("2026-08-30T23:00:00Z") },
  { path: "/fixture/small.jsonl", size: 70_000_060, mtimeMs: Date.parse("2026-08-30T22:00:00Z") },
];
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const emptyScanCache = encodeJson(encodeScanCache(new Map()));
let inventoryComplete = true;
vi.mock("./usageTranscriptReader.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./usageTranscriptReader.ts")>()),
  listTranscriptFilesBounded: vi.fn(async (root: string) => ({
    files: /[\\/]sessions$/.test(root) && !/[\\/]codex-home[\\/]/.test(root) ? files : [],
    complete: inventoryComplete,
  })),
  readDirectoryVolumeId: vi.fn(async () => "fixture"),
  transcriptCursorIsLineBoundary: vi.fn(async () => true),
  readTranscriptRecords: vi.fn(async () => ({
    records: [],
    nextByte: Number.MAX_SAFE_INTEGER,
    discardedLines: 0,
    discardingLine: false,
    codexState: initialCodexScanState(),
  })),
  readRepeatedInputRecords: vi.fn(async () => null),
}));

const testLayer = Layer.mergeAll(
  ServerSettings.layerTest(),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-scan-budget-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("incremental scan integration", () => {
  for (const includeQuotaHistory of [false, true]) {
    it.effect(`bounds stalled settings with quota history ${includeQuotaHistory}`, () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        const started = yield* Deferred.make<void>();
        const service = yield* make.pipe(
          Effect.provideService(ServerSettings.ServerSettingsService, {
            ...settings,
            getSettings: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Offline fixture")),
          ),
        );
        let completed: Exit.Exit<unknown, unknown> | undefined;
        yield* service
          .readSummary({
            sinceDay: UsageDay.make("2026-08-29"),
            untilDay: UsageDay.make("2026-09-02"),
            timeZone: "UTC",
            includeQuotaHistory,
          })
          .pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                completed = exit;
              }),
            ),
            Effect.forkChild,
          );
        yield* Deferred.await(started);
        yield* TestClock.adjust("12 seconds");
        expect(completed).toBeDefined();
        if (completed !== undefined) {
          expect(Exit.isFailure(completed)).toBe(true);
          expect(encodeJson(completed)).toContain("before source coverage could be established");
        }
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(testLayer, TestClock.layer()))),
    );
  }

  it.effect("keeps a shared wait inside each caller's original deadline", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const settings = yield* ServerSettings.ServerSettingsService;
      const settingsStarted = yield* Deferred.make<void>();
      const releaseSettings = yield* Deferred.make<void>();
      const cacheStarted = yield* Deferred.make<void>();
      let settingsReads = 0;
      const service = yield* make.pipe(
        Effect.provideService(ServerSettings.ServerSettingsService, {
          ...settings,
          getSettings: Effect.gen(function* () {
            settingsReads += 1;
            if (settingsReads === 1) {
              yield* Deferred.succeed(settingsStarted, undefined);
              yield* Deferred.await(releaseSettings);
            }
            return yield* settings.getSettings;
          }),
        }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: () => Effect.succeed(true),
          readFileString: (path, ...args) =>
            path.endsWith("usage-scan-cache.json")
              ? Deferred.succeed(cacheStarted, undefined).pipe(Effect.andThen(Effect.never))
              : path.endsWith("usage-imports.json")
                ? Effect.succeed("")
                : fs.readFileString(path, ...args),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Offline fixture")),
        ),
      );
      const input = {
        sinceDay: UsageDay.make("2026-08-29"),
        untilDay: UsageDay.make("2026-09-02"),
        timeZone: "UTC",
        providers: ["codex"] as const,
      };
      let waiterCompleted = false;
      let ownerCompleted = false;
      const waiter = yield* service.readSummary(input).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            waiterCompleted = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(settingsStarted);
      yield* TestClock.adjust("4 seconds");
      const owner = yield* service.readSummary(input).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            ownerCompleted = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(cacheStarted);
      yield* Deferred.succeed(releaseSettings, undefined);
      yield* TestClock.adjust("8 seconds");
      expect(waiterCompleted).toBe(true);
      const waitingResult = yield* Fiber.join(waiter);
      expect(waitingResult.scanDurationMs).toBe(12_000);
      expect(waitingResult.sources.length).toBeGreaterThan(0);
      expect(waitingResult.sources.every((source) => source.status === "partial")).toBe(true);
      expect(ownerCompleted).toBe(false);
      yield* TestClock.adjust("4 seconds");
      const ownerResult = yield* Fiber.join(owner);
      expect(ownerResult.sources.every((source) => source.status === "partial")).toBe(true);
      expect(settingsReads).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(testLayer, TestClock.layer()))),
  );

  it.effect("keeps warm totals through partial inventory and complete transcript deletion", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nowMs = Date.parse("2026-09-20T12:00:00Z");
      const path = yield* Path.Path;
      yield* TestClock.setTime(nowMs);

      const usage: UsageRecord = {
        provider: "codex",
        model: "gpt-5.6-sol",
        sessionId: "warm-session",
        timestampMs: nowMs - 60_000,
        totals: {
          uncachedInputTokens: 10,
          cachedInputTokens: 2,
          cacheCreationTokens: 0,
          outputTokens: 3,
          reasoningTokens: 0,
        },
        reportedCostUsd: null,
        dedupeKey: "warm-record",
      };
      const warm = { path: "", size: 1_000, mtimeMs: nowMs - 30_000 };
      let root = "";
      let phase: "present" | "partial" | "deleted" = "present";

      vi.mocked(readTranscriptRecords).mockClear();
      const originalListing = vi.mocked(listTranscriptFilesBounded).getMockImplementation()!;
      const originalRead = vi.mocked(readTranscriptRecords).getMockImplementation()!;
      try {
        vi.mocked(listTranscriptFilesBounded).mockImplementation(async (candidate) => {
          const primary =
            /[\\/]sessions$/.test(candidate) && !/[\\/]codex-home[\\/]/.test(candidate);
          if (!primary) return { files: [], complete: true };
          root = candidate;
          warm.path = path.join(candidate, "warm.jsonl");
          if (phase === "partial") return { files: [], complete: false };
          if (phase === "deleted") return { files: [], complete: true };
          return { files: [{ ...warm }], complete: true };
        });
        vi.mocked(readTranscriptRecords).mockImplementation(
          async (filePath, _provider, options) => ({
            records: filePath === warm.path && (options?.startByte ?? 0) === 0 ? [usage] : [],
            nextByte: warm.size,
            discardedLines: 0,
            discardingLine: false,
            codexState: initialCodexScanState(),
          }),
        );

        const service = yield* make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: () => Effect.succeed(true),
            readFileString: (path, ...args) =>
              path.endsWith("usage-scan-cache.json")
                ? Effect.succeed(emptyScanCache)
                : fs.readFileString(path, ...args),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Offline fixture")),
          ),
        );
        const input = {
          sinceDay: UsageDay.make("2026-09-19"),
          untilDay: UsageDay.make("2026-09-21"),
          timeZone: "UTC",
          providers: ["codex"] as const,
          refresh: true,
        };
        const total = (summary: UsageSummary) =>
          summary.buckets.reduce((sum, bucket) => sum + bucket.totals.uncachedInputTokens, 0);
        const rootSource = (summary: UsageSummary) =>
          summary.sources.find((source) => source.fingerprint.resolvedHomePath === root);

        const first = yield* service.readSummary(input);
        expect(total(first)).toBe(10);
        expect(rootSource(first)?.status).toBe("ok");
        expect(readTranscriptRecords).toHaveBeenCalledTimes(1);

        vi.mocked(transcriptCursorIsLineBoundary).mockClear();
        phase = "partial";
        const partial = yield* service.readSummary(input);
        expect(total(partial)).toBe(10);
        expect(rootSource(partial)?.status).toBe("partial");
        expect(readTranscriptRecords).toHaveBeenCalledTimes(1);

        phase = "present";
        const complete = yield* service.readSummary(input);
        expect(total(complete)).toBe(10);
        expect(rootSource(complete)?.status).toBe("ok");
        expect(readTranscriptRecords).toHaveBeenCalledTimes(1);

        expect(transcriptCursorIsLineBoundary).not.toHaveBeenCalled();
        phase = "deleted";
        const deleted = yield* service.readSummary(input);
        expect(total(deleted)).toBe(10);
        expect(rootSource(deleted)?.status).toBe("ok");
        expect(readTranscriptRecords).toHaveBeenCalledTimes(1);

        const persistedCache = encodeJson(
          encodeScanCache(
            new Map([
              [
                warm.path,
                {
                  size: warm.size,
                  mtimeMs: nowMs - 200 * 24 * 60 * 60 * 1000,
                  provider: "codex",
                  records: [usage],
                },
              ],
            ]) satisfies ScanCache,
            [
              {
                provider: "codex",
                rootPath: root,
                sinceMs: nowMs - 90 * 24 * 60 * 60 * 1000,
                scannedAtMs: nowMs,
                volumeId: "fixture",
              },
            ],
          ),
        );
        vi.mocked(readTranscriptRecords).mockClear();
        const restartedService = yield* make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: (candidate) => Effect.succeed(candidate !== root),
            readFileString: (candidate, ...args) =>
              candidate.endsWith("usage-scan-cache.json")
                ? Effect.succeed(persistedCache)
                : fs.readFileString(candidate, ...args),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Offline fixture")),
          ),
        );
        const afterRestart = yield* restartedService.readSummary(input);
        expect(total(afterRestart)).toBe(10);
        expect(rootSource(afterRestart)?.status).toBe("partial");
        expect(rootSource(afterRestart)?.fingerprint.volumeId).toBe("fixture");
        expect(readTranscriptRecords).not.toHaveBeenCalled();
      } finally {
        vi.mocked(listTranscriptFilesBounded).mockImplementation(originalListing);
        vi.mocked(readTranscriptRecords).mockImplementation(originalRead);
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(testLayer, TestClock.layer()))),
  );

  it.effect("resumes persisted chunks with exact token totals and no duplicate records", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const record = (
        dedupeKey: string,
        timestampMs: number,
        uncachedInputTokens: number,
        cachedInputTokens: number,
        outputTokens: number,
      ): UsageRecord => ({
        provider: "codex",
        model: "gpt-5.6-sol",
        sessionId: "session-a",
        timestampMs,
        totals: {
          uncachedInputTokens,
          cachedInputTokens,
          cacheCreationTokens: 0,
          outputTokens,
          reasoningTokens: 0,
        },
        reportedCostUsd: null,
        dedupeKey,
      });
      const firstRecord = record("first", Date.parse("2026-08-30T23:00:00Z"), 10, 2, 3);
      const secondRecord = record("second", Date.parse("2026-08-30T23:01:00Z"), 30, 4, 5);
      const initialByPath = new Map<string, readonly UsageRecord[]>([
        [files[0]!.path, [firstRecord]],
      ]);
      const completeByPath = new Map<string, readonly UsageRecord[]>([
        [files[0]!.path, [firstRecord, secondRecord]],
      ]);
      let completePass = false;
      vi.mocked(listTranscriptFilesBounded).mockImplementation(async (root: string) => ({
        files: /[\\/]sessions$/.test(root) && !/[\\/]codex-home[\\/]/.test(root) ? [files[0]!] : [],
        complete: inventoryComplete,
      }));
      vi.mocked(readTranscriptRecords).mockImplementation(async (filePath, _provider, options) => {
        const firstChunk = initialByPath.get(filePath) ?? [];
        const completeRecords = completeByPath.get(filePath) ?? [];
        const startByte = options?.startByte ?? 0;
        return {
          records:
            startByte === 0
              ? completePass
                ? completeRecords
                : firstChunk
              : [...firstChunk, ...completeRecords.slice(1)],
          nextByte: completePass || startByte > 0 ? Number.MAX_SAFE_INTEGER : 10,
          discardedLines: 0,
          discardingLine: false,
          codexState: initialCodexScanState(),
        };
      });
      try {
        let persistedCache: string | undefined;
        const input = {
          sinceDay: UsageDay.make("2026-08-29"),
          untilDay: UsageDay.make("2026-09-02"),
          timeZone: "UTC",
          providers: ["codex"] as const,
          refresh: true,
        };
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const firstService = yield* make.pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                exists: () => Effect.succeed(true),
                readFileString: (path, ...args) =>
                  path.endsWith("usage-scan-cache.json")
                    ? Effect.succeed(emptyScanCache)
                    : fs.readFileString(path, ...args),
                writeFileString: (path, contents, ...args) => {
                  if (path.endsWith("contents.tmp")) persistedCache = contents;
                  return fs.writeFileString(path, contents, ...args);
                },
              }),
              Effect.provideService(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("Offline fixture")),
              ),
            );
            return yield* firstService.readSummary(input);
          }),
        );
        expect(first.sources.some((source) => source.status === "partial")).toBe(true);
        expect(persistedCache).toContain('"q":10');

        completePass = true;
        vi.mocked(readTranscriptRecords).mockClear();
        const resumedService = yield* make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: () => Effect.succeed(true),
            readFileString: (path, ...args) =>
              path.endsWith("usage-scan-cache.json")
                ? Effect.succeed(persistedCache ?? emptyScanCache)
                : fs.readFileString(path, ...args),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Offline fixture")),
          ),
        );
        const resumed = yield* resumedService.readSummary(input);
        expect(vi.mocked(readTranscriptRecords)).toHaveBeenCalledTimes(1);
        expect(
          vi.mocked(readTranscriptRecords).mock.calls.map(([, , options]) => options?.startByte),
        ).toEqual([10]);

        vi.mocked(readTranscriptRecords).mockClear();
        const completeService = yield* make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: () => Effect.succeed(true),
            readFileString: (path, ...args) =>
              path.endsWith("usage-scan-cache.json")
                ? Effect.succeed(emptyScanCache)
                : fs.readFileString(path, ...args),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Offline fixture")),
          ),
        );
        const complete = yield* completeService.readSummary(input);
        expect(resumed.buckets.map(({ totals }) => totals)).toEqual(
          complete.buckets.map(({ totals }) => totals),
        );
        expect(resumed.buckets[0]!.totals).toEqual({
          uncachedInputTokens: 40,
          cachedInputTokens: 6,
          cacheCreationTokens: 0,
          outputTokens: 8,
          reasoningTokens: 0,
        });
      } finally {
        vi.mocked(listTranscriptFilesBounded).mockImplementation(async (root: string) => ({
          files: /[\\/]sessions$/.test(root) && !/[\\/]codex-home[\\/]/.test(root) ? files : [],
          complete: inventoryComplete,
        }));
        vi.mocked(readTranscriptRecords).mockImplementation(async () => ({
          records: [],
          nextByte: Number.MAX_SAFE_INTEGER,
          discardedLines: 0,
          discardingLine: false,
          codexState: initialCodexScanState(),
        }));
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "returns an explicit partial summary at the response deadline and releases the scan",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const fingerprint = {
          hostId: "fixture",
          provider: "codex" as const,
          resolvedHomePath: "/sessions",
          volumeId: "fixture",
        };
        const saved = {
          key: quotaCostLedgerKey(fingerprint, "cycle"),
          fingerprint,
          intervalId: "cycle",
          sinceTime: "2026-08-31T00:00:00Z",
          untilTime: "2026-08-31T01:00:00Z",
          costUsd: 125,
          records: 4,
          unpricedRecords: 0,
          recordedAt: "2026-08-31T02:00:00Z",
          firstRemainingPercent: 100,
          lastRemainingPercent: 80,
          resetsAt: "2026-09-07T00:00:00Z",
        };
        yield* fs.writeFileString(
          path.join(config.stateDir, "usage-quota-cost-ledger.json"),
          encodeJson({ version: 1, rows: [saved] }),
        );
        const firstCacheRead = yield* Deferred.make<void>();
        let stallCacheLoad = true;
        let cacheReads = 0;
        const service = yield* make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: () => Effect.succeed(stallCacheLoad),
            readFileString: (path, ...args) =>
              path.endsWith("usage-scan-cache.json")
                ? Effect.gen(function* () {
                    cacheReads += 1;
                    if (stallCacheLoad) {
                      yield* Deferred.succeed(firstCacheRead, undefined);
                      return yield* Effect.never;
                    }
                    return emptyScanCache;
                  })
                : fs.readFileString(path, ...args),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Offline fixture")),
          ),
        );
        const input = {
          sinceDay: UsageDay.make("2026-08-29"),
          untilDay: UsageDay.make("2026-09-02"),
          timeZone: "UTC",
          providers: ["codex"] as const,
          quotaIntervals: [
            { id: "cycle", sinceTime: "2026-08-31T00:00:00Z", untilTime: "2026-08-31T01:00:00Z" },
          ],
        };
        const first = yield* service.readSummary(input).pipe(Effect.forkChild);
        yield* Deferred.await(firstCacheRead);
        yield* TestClock.adjust("12 seconds");
        const partial = yield* Fiber.join(first);
        expect(partial.buckets).toEqual([]);
        expect(partial.quotaCosts).toEqual([]);
        expect(partial.quotaCostSnapshots).toEqual([saved]);
        expect(partial.quotaHistory).toBeDefined();
        expect(partial.sources.every((source) => source.fingerprint.volumeId === "fixture")).toBe(
          true,
        );
        expect(partial.pricing.status).toBe("unavailable");
        expect(partial.sources).not.toHaveLength(0);
        expect(partial.sources.every((source) => source.status === "partial")).toBe(true);
        expect(
          partial.sources.every((source) => source.message?.includes("response budget expired")),
        ).toBe(true);

        stallCacheLoad = false;
        const retry = yield* service.readSummary(input);
        expect(retry.sources.every((source) => source.status === "missing")).toBe(true);
        expect(cacheReads).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(testLayer, TestClock.layer()))),
  );

  it.effect("marks totals partial when transcript inventory reaches its response budget", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      inventoryComplete = false;
      try {
        const service = yield* make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: () => Effect.succeed(true),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Offline fixture")),
          ),
        );
        const summary = yield* service.readSummary({
          sinceDay: UsageDay.make("2026-08-29"),
          untilDay: UsageDay.make("2026-09-02"),
          timeZone: "UTC",
          providers: ["codex"],
          refresh: true,
        });
        expect(summary.sources).not.toHaveLength(0);
        expect(summary.sources.every((source) => source.status === "partial")).toBe(true);
        expect(summary.sources.every((source) => source.message?.includes("response budget"))).toBe(
          true,
        );
      } finally {
        inventoryComplete = true;
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "reprices cached Codex history after a manual tier correction without rereading transcripts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fetchedAtMs = yield* Clock.currentTimeMillis;
        const usage = {
          provider: "codex" as const,
          model: "gpt-5.6-sol",
          sessionId: "session",
          timestampMs: Date.parse("2026-08-31T01:00:00Z"),
          totals: {
            uncachedInputTokens: 1_000,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 100,
            reasoningTokens: 0,
          },
          reportedCostUsd: null,
          dedupeKey: null,
        };
        const cache = encodeScanCache(
          new Map(
            files.map((file, index) => [
              file.path,
              {
                ...file,
                provider: "codex" as const,
                records: index === 0 ? [usage] : [],
                codexState: initialCodexScanState(),
              },
            ]),
          ),
        );
        let corrections = "[]";
        vi.mocked(readTranscriptRecords).mockClear();
        const service = yield* make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: () => Effect.succeed(true),
            readFileString: (path, ...args) => {
              if (path.endsWith("usage-scan-cache.json")) return Effect.succeed(encodeJson(cache));
              if (path.endsWith("usage-codex-fast-windows.json"))
                return Effect.succeed(corrections);
              if (path.endsWith("usage-model-rates.json"))
                return Effect.succeed(
                  encodeJson({
                    fetchedAtMs,
                    document: {
                      "gpt-5.6-sol": {
                        input_cost_per_token: 4e-6,
                        output_cost_per_token: 20e-6,
                        input_cost_per_token_priority: 8e-6,
                        output_cost_per_token_priority: 40e-6,
                      },
                    },
                  }),
                );
              return fs.readFileString(path, ...args);
            },
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Offline fixture")),
          ),
        );
        const input = {
          sinceDay: UsageDay.make("2026-08-29"),
          untilDay: UsageDay.make("2026-09-02"),
          timeZone: "UTC",
          refresh: true,
          quotaIntervals: [
            { id: "cycle", sinceTime: "2026-08-30T23:00:00Z", untilTime: "2026-08-31T03:00:00Z" },
          ],
        };
        const before = yield* service.readSummary(input);
        corrections = encodeJson([
          {
            sinceTime: "2026-08-30T23:00:00Z",
            untilTime: "2026-08-31T03:00:00Z",
            note: "User report",
          },
        ]);
        const after = yield* service.readSummary(input);
        expect(before.buckets[0]!.costUsd).toBeCloseTo(0.006);
        expect(after.buckets[0]!.costUsd).toBeCloseTo(0.012);
        expect(after.buckets[0]!.totals).toEqual(before.buckets[0]!.totals);
        expect(after.quotaCosts!.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(0.012);
        expect(readTranscriptRecords).not.toHaveBeenCalled();
        corrections = "[]";
        const removed = yield* service.readSummary(input);
        expect(removed.buckets[0]!.costUsd).toBeCloseTo(0.006);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("serves a cached window while another range is blocked on the scan semaphore", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const loading = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let directoryExists = false;
      const service = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: () => Effect.succeed(directoryExists),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Offline fixture")),
        ),
      );
      const cachedInput = {
        sinceDay: UsageDay.make("2026-08-29"),
        untilDay: UsageDay.make("2026-09-02"),
        timeZone: "UTC",
        quotaIntervals: [],
      };
      yield* service.readSummary(cachedInput);
      directoryExists = true;
      vi.mocked(readTranscriptRecords).mockImplementationOnce(async () => {
        loading.resolve();
        await release.promise;
        return {
          records: [],
          nextByte: Number.MAX_SAFE_INTEGER,
          discardedLines: 0,
          discardingLine: false,
          codexState: initialCodexScanState(),
        };
      });
      const blocked = yield* service
        .readSummary({ ...cachedInput, sinceDay: UsageDay.make("2026-08-28") })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => loading.promise);
      // Keep a generous guard so a semaphore regression cannot hang the suite;
      // this is not a cache-latency target.
      const cached = yield* service
        .readSummary(cachedInput)
        .pipe(Effect.timeout(1_000), Effect.exit);
      expect(cached._tag).toBe("Success");
      release.resolve();
      yield* Fiber.join(blocked);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("retries the cache load after its first reader is cancelled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const loading = yield* Deferred.make<void>();
      let cacheReads = 0;
      const service = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: () => Effect.succeed(false),
          readFileString: (path, ...args) =>
            path.endsWith("usage-scan-cache.json")
              ? Effect.gen(function* () {
                  cacheReads += 1;
                  if (cacheReads === 1) {
                    yield* Deferred.succeed(loading, undefined);
                    return yield* Effect.never;
                  }
                  return emptyScanCache;
                })
              : fs.readFileString(path, ...args),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Offline fixture")),
        ),
      );
      const input = {
        sinceDay: UsageDay.make("2026-08-29"),
        untilDay: UsageDay.make("2026-09-02"),
        timeZone: "UTC",
        quotaIntervals: [],
        refresh: true,
      };
      const first = yield* service.readSummary(input).pipe(Effect.forkChild);
      yield* Deferred.await(loading);
      yield* Fiber.interrupt(first);
      const retry = yield* service.readSummary(input).pipe(Effect.exit);
      expect(retry._tag).toBe("Success");
      expect(cacheReads).toBe(2);
      yield* service.readSummary(input);
      expect(cacheReads).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("flushes a queued cache revision when the service scope closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const firstCacheWrite = yield* Deferred.make<void>();
      let cacheTempWrites = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* make.pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              exists: () => Effect.succeed(true),
              writeFileString: (path, contents, ...args) => {
                if (path.endsWith("contents.tmp")) {
                  cacheTempWrites += 1;
                  if (cacheTempWrites === 1) {
                    return Effect.gen(function* () {
                      yield* Deferred.succeed(firstCacheWrite, undefined);
                      return yield* Effect.die("defer first cache publish");
                    });
                  }
                }
                return fs.writeFileString(path, contents, ...args);
              },
            }),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("Offline fixture")),
            ),
          );
          yield* service.readSummary({
            sinceDay: UsageDay.make("2026-08-29"),
            untilDay: UsageDay.make("2026-09-02"),
            timeZone: "UTC",
            quotaIntervals: [],
            refresh: true,
          });
          yield* Deferred.await(firstCacheWrite);
        }),
      );

      expect(cacheTempWrites).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("uses validated append cursors for both the scan budget and actual reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cache = encodeScanCache(
        new Map(
          files.map((file, index) => [
            file.path,
            {
              size: file.size - (index === 0 ? 40 : 60),
              mtimeMs: file.mtimeMs - 1,
              provider: "codex" as const,
              records: [],
              codexState: initialCodexScanState(),
            },
          ]),
        ),
      );
      const writes: string[] = [];
      const persisted = yield* Deferred.make<void>();
      vi.mocked(readTranscriptRecords).mockClear();
      vi.mocked(transcriptCursorIsLineBoundary).mockClear();
      const service = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: () => Effect.succeed(true),
          readFileString: (path, ...args) =>
            path.endsWith("usage-scan-cache.json")
              ? Effect.succeed(JSON.stringify(cache))
              : fs.readFileString(path, ...args),
          writeFileString: (path, contents, ...args) => {
            writes.push(path);
            return fs
              .writeFileString(path, contents, ...args)
              .pipe(
                Effect.tap(() =>
                  path.endsWith("contents.tmp")
                    ? Deferred.succeed(persisted, undefined)
                    : Effect.void,
                ),
              );
          },
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Offline fixture")),
        ),
      );
      const result = yield* service.readSummary({
        sinceDay: UsageDay.make("2026-08-29"),
        untilDay: UsageDay.make("2026-09-02"),
        timeZone: "UTC",
        quotaIntervals: [],
        refresh: true,
      });
      yield* Deferred.await(persisted);
      expect(result.sources.every((source) => source.status === "ok")).toBe(true);
      expect(readTranscriptRecords).toHaveBeenCalledTimes(2);
      expect(readTranscriptRecords).toHaveBeenCalledWith(
        files[0]!.path,
        "codex",
        expect.objectContaining({ startByte: 200_000_000 }),
      );
      expect(readTranscriptRecords).toHaveBeenCalledWith(
        files[1]!.path,
        "codex",
        expect.objectContaining({ startByte: 70_000_000 }),
      );
      expect(transcriptCursorIsLineBoundary).toHaveBeenCalledTimes(2);
      expect(writes.some((path) => path.endsWith("contents.tmp"))).toBe(true);
      expect(writes.some((path) => path.endsWith("usage-scan-cache.json"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("defers old warm entries until repeated-input metadata is rebuilt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const encodedCache = encodeScanCache(
        new Map(
          files.map((file) => [
            file.path,
            {
              ...file,
              provider: "codex" as const,
              records: [],
              codexState: initialCodexScanState(),
            },
          ]),
        ),
      );
      const oldCache = encodeJson({ ...encodedCache, version: 6 });
      vi.mocked(readTranscriptRecords).mockClear();
      vi.mocked(readRepeatedInputRecords).mockClear();
      const service = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: () => Effect.succeed(true),
          readFileString: (path, ...args) =>
            path.endsWith("usage-scan-cache.json")
              ? Effect.succeed(oldCache)
              : fs.readFileString(path, ...args),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Offline fixture")),
        ),
      );
      const result = yield* service.readSummary({
        sinceDay: UsageDay.make("2026-08-29"),
        untilDay: UsageDay.make("2026-09-02"),
        timeZone: "UTC",
        providers: ["codex"],
        includeRepeatedInput: true,
        refresh: true,
      });

      const codexSource = result.sources.find((source) => source.fingerprint.provider === "codex");
      expect(codexSource?.status).toBe("partial");
      expect(readTranscriptRecords).not.toHaveBeenCalled();
      expect(readRepeatedInputRecords).toHaveBeenCalledTimes(1);
      expect(readRepeatedInputRecords).toHaveBeenCalledWith(
        files[1]!.path,
        expect.objectContaining({ startByte: 0 }),
      );
      expect(readRepeatedInputRecords).not.toHaveBeenCalledWith(files[0]!.path, expect.anything());
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a large cache write off requests and publishes the newest revision", () =>
    Effect.gen(function* () {
      const writeStarted = yield* Deferred.make<void>();
      const releaseWrite = yield* Deferred.make<void>();
      const persistedTwice = yield* Deferred.make<void>();
      const originalMtime = files[0]!.mtimeMs;
      const originalSizes = files.map((file) => file.size);
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const snapshots: string[] = [];
        let tempWrites = 0;
        let renames = 0;
        files[0]!.size = 10_000;
        files[1]!.size = 20_000;
        const service = yield* make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: () => Effect.succeed(true),
            writeFileString: (path, contents, ...args) => {
              if (!path.endsWith("contents.tmp"))
                return fs.writeFileString(path, contents, ...args);
              tempWrites += 1;
              snapshots.push(contents);
              if (tempWrites === 1) {
                return Effect.gen(function* () {
                  yield* Deferred.succeed(writeStarted, undefined);
                  yield* Deferred.await(releaseWrite);
                  return yield* fs.writeFileString(path, contents, ...args);
                });
              }
              return fs.writeFileString(path, contents, ...args);
            },
            rename: (from, to, ...args) => {
              if (from.endsWith("contents.tmp") && to.endsWith("usage-scan-cache.json")) {
                renames += 1;
                if (renames === 2) {
                  return fs
                    .rename(from, to, ...args)
                    .pipe(Effect.tap(() => Deferred.succeed(persistedTwice, undefined)));
                }
              }
              return fs.rename(from, to, ...args);
            },
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Offline fixture")),
          ),
        );
        const input = {
          sinceDay: UsageDay.make("2026-08-29"),
          untilDay: UsageDay.make("2026-09-02"),
          timeZone: "UTC",
          quotaIntervals: [],
          refresh: true,
        };
        const first = yield* service.readSummary(input).pipe(Effect.forkChild);
        yield* Deferred.await(writeStarted);
        const firstSummary = yield* Fiber.join(first);
        expect(firstSummary.sources.every((source) => source.status === "ok")).toBe(true);

        files[0]!.mtimeMs = originalMtime + 1_000;
        const second = yield* service.readSummary({
          ...input,
          sinceDay: UsageDay.make("2026-08-28"),
        });
        expect(second.sources.every((source) => source.status === "ok")).toBe(true);

        files[0]!.mtimeMs = originalMtime + 2_000;
        const third = yield* service.readSummary({
          ...input,
          sinceDay: UsageDay.make("2026-08-27"),
        });
        expect(third.sources.every((source) => source.status === "ok")).toBe(true);

        yield* Deferred.succeed(releaseWrite, undefined);
        yield* Deferred.await(persistedTwice);
        expect(tempWrites).toBe(2);
        expect(renames).toBe(2);
        expect(snapshots[1]).toContain(String(originalMtime + 2_000));
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Deferred.succeed(releaseWrite, undefined);
            yield* Effect.sync(() => {
              files[0]!.mtimeMs = Date.parse("2026-08-30T23:00:00Z");
              files.forEach((file, index) => {
                file.size = originalSizes[index]!;
              });
            });
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
