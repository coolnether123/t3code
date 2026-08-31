import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient } from "effect/unstable/http";
import { UsageDay } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { make } from "./UsageService.ts";
import { encodeScanCache } from "./usageScanCache.ts";
import { initialCodexScanState } from "./usageTranscripts.ts";
import { readTranscriptRecords, transcriptCursorIsLineBoundary } from "./usageTranscriptReader.ts";

const files = [
  { path: "/fixture/large.jsonl", size: 200_000_040, mtimeMs: Date.parse("2026-08-30T23:00:00Z") },
  { path: "/fixture/small.jsonl", size: 70_000_060, mtimeMs: Date.parse("2026-08-30T22:00:00Z") },
];
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const emptyScanCache = encodeJson(encodeScanCache(new Map()));
vi.mock("./usageTranscriptReader.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./usageTranscriptReader.ts")>()),
  listTranscriptFiles: vi.fn(async (root: string) => (/[\\/]sessions$/.test(root) ? files : [])),
  readDirectoryVolumeId: vi.fn(async () => "fixture"),
  transcriptCursorIsLineBoundary: vi.fn(async () => true),
  readTranscriptRecords: vi.fn(async () => ({ records: [], codexState: initialCodexScanState() })),
}));

const testLayer = Layer.mergeAll(
  ServerSettings.layerTest(),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-scan-budget-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("incremental scan integration", () => {
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
      }).pipe(Effect.provide(testLayer), Effect.scoped),
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
    }).pipe(Effect.provide(testLayer), Effect.scoped),
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
            return fs.writeFileString(path, contents, ...args);
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
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
