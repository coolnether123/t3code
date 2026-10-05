import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { UsageDay } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { beforeEach, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { make } from "./UsageService.ts";
import {
  createRepeatedInputCatalog,
  discoverCodexRepeatedInputSources,
  initialRepeatedInputParserState,
  type RepeatedInputObservation,
} from "./usageRepeatedInput.ts";
import { encodeScanCache } from "./usageScanCache.ts";
import {
  listTranscriptFilesBounded,
  readRepeatedInputRecords,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";
import { initialCodexScanState, type UsageRecord } from "./usageTranscripts.ts";

const files = [
  { path: "/fixture/newer.jsonl", size: 200, mtimeMs: Date.parse("2026-08-31T12:00:00Z") },
  { path: "/fixture/older.jsonl", size: 100, mtimeMs: Date.parse("2026-08-31T11:00:00Z") },
];
const records: readonly UsageRecord[] = files.map((file, index) => ({
  provider: "codex",
  model: "fixture-model",
  timestampMs: file.mtimeMs,
  sessionId: `fixture-session-${index}`,
  turnId: `fixture-turn-${index}`,
  dedupeKey: `fixture-record-${index}`,
  totals: {
    uncachedInputTokens: 50,
    cachedInputTokens: 40,
    cacheCreationTokens: 10,
    outputTokens: 20,
    reasoningTokens: 5,
  },
  reportedCostUsd: 0.25,
}));
const catalog = createRepeatedInputCatalog([
  { path: "/fixture/skills/example/SKILL.md", content: "Synthetic skill", tokenCount: 3 },
]);
const observation: RepeatedInputObservation = {
  ...catalog.sources[0]!,
  confidence: "confirmedPayload",
  observedAtMs: records[0]!.timestampMs,
  sessionId: records[0]!.sessionId,
  turnId: records[0]!.turnId!,
  model: records[0]!.model,
  project: null,
  environment: "fixture",
  directTokens: { exact: 3, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 },
  fullSessionInputTokens: { exact: 50, estimated: 0, cached: 40, cacheWrite: 10, unknown: 0 },
  providerReportedCostUsd: 0.1,
  dedupeKey: "fixture-observation",
};

vi.mock("./usageTranscriptReader.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./usageTranscriptReader.ts")>()),
  listTranscriptFilesBounded: vi.fn(async (root: string) => ({
    files: /[\\/]sessions$/.test(root) && !/[\\/]codex-home[\\/]/.test(root) ? files : [],
    complete: true,
  })),
  readDirectoryVolumeId: vi.fn(async () => "fixture"),
  readTranscriptPrefixFingerprint: vi.fn(async () => "fixture-prefix"),
  readTranscriptRecords: vi.fn(),
  readRepeatedInputRecords: vi.fn(),
}));
vi.mock("./usageRepeatedInput.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./usageRepeatedInput.ts")>()),
  discoverCodexRepeatedInputSources: vi.fn(),
}));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
let cachedFixture = encodeScanCache(new Map());
const input = {
  sinceDay: UsageDay.make("2026-08-31"),
  untilDay: UsageDay.make("2026-08-31"),
  timeZone: "UTC",
  providers: ["codex"] as const,
  groupBy: "turn" as const,
};
const testLayer = Layer.mergeAll(
  ServerSettings.layerTest({ providers: { codex: { homePath: "/fixture/codex" } } }),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-repeated-timeout-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* make.pipe(
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      exists: () => Effect.succeed(true),
      readFileString: (path, ...args) =>
        path.endsWith("usage-scan-cache.json")
          ? Effect.succeed(encodeJson(cachedFixture))
          : path.endsWith("usage-imports.json")
            ? Effect.succeed("")
            : fs.readFileString(path, ...args),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              "fixture-model": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
            }),
          ),
        ),
      ),
    ),
  );
});

beforeEach(() => {
  files[0]!.size = 200;
  files[1]!.size = 100;
  cachedFixture = encodeScanCache(new Map());
  vi.mocked(listTranscriptFilesBounded).mockClear();
  vi.mocked(discoverCodexRepeatedInputSources).mockReset().mockResolvedValue({
    catalog,
    sources: catalog.sources,
    gaps: [],
  });
  vi.mocked(readTranscriptRecords)
    .mockReset()
    .mockImplementation(async (filePath) => {
      const index = files.findIndex((file) => file.path === filePath);
      return {
        records: [records[index]!],
        nextByte: files[index]!.size,
        discardedLines: 0,
        discardingLine: false,
        codexState: initialCodexScanState(),
      };
    });
  vi.mocked(readRepeatedInputRecords)
    .mockReset()
    .mockResolvedValue({
      observations: [observation],
      gaps: [],
      parserState: initialRepeatedInputParserState(),
    });
});

describe("repeated-input response budget", () => {
  for (const stage of ["catalog", "transcript"] as const) {
    for (const warm of [false, true]) {
      it.effect(
        `retains ${warm ? "warm" : "cold"} ordinary totals when ${stage} attribution stalls`,
        () =>
          Effect.gen(function* () {
            const service = yield* setup;
            yield* service.refreshRates;
            const ordinary = warm ? yield* service.readSummary(input) : undefined;
            const started = Promise.withResolvers<void>();
            if (stage === "catalog") {
              vi.mocked(discoverCodexRepeatedInputSources).mockImplementationOnce(() => {
                started.resolve();
                return new Promise(() => {});
              });
            } else {
              vi.mocked(readRepeatedInputRecords).mockImplementationOnce(() => {
                started.resolve();
                return new Promise(() => {});
              });
            }
            const read = yield* service
              .readSummary({ ...input, includeRepeatedInput: true })
              .pipe(Effect.forkChild);
            yield* Effect.promise(() => started.promise);
            yield* TestClock.adjust("12 seconds");
            const partial = yield* Fiber.join(read);
            const expected = ordinary ?? (yield* service.readSummary(input));
            expect(partial.buckets).toEqual(expected.buckets);
            expect(partial.sources).toEqual(expected.sources);
            expect(partial.pricing).toEqual(expected.pricing);
            expect(partial.repeatedInput?.coverageGaps).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  reason: "unattributed",
                  message: expect.stringContaining("response budget"),
                }),
              ]),
            );
            expect(partial.repeatedInput?.estimatedApiCostUsd).toBeNull();
            const retry = yield* service.readSummary({ ...input, includeRepeatedInput: true });
            expect(retry.buckets).toEqual(expected.buckets);
            expect(retry.repeatedInput?.items).toHaveLength(1);
          }).pipe(Effect.scoped, Effect.provide(Layer.merge(testLayer, TestClock.layer()))),
      );
    }
  }

  it.effect("keeps warm ordinary buckets when attribution exceeds its byte budget", () =>
    Effect.gen(function* () {
      files[0]!.size = 200_000_000;
      files[1]!.size = 70_000_000;
      cachedFixture = encodeScanCache(
        new Map(
          files.map((file, index) => [
            file.path,
            {
              ...file,
              provider: "codex" as const,
              records: [records[index]!],
              codexState: initialCodexScanState(),
            },
          ]),
        ),
      );
      const service = yield* setup;
      yield* service.refreshRates;
      const ordinary = yield* service.readSummary(input);
      const partial = yield* service.readSummary({ ...input, includeRepeatedInput: true });
      expect(partial.buckets).toEqual(ordinary.buckets);
      expect(partial.sources).toEqual(ordinary.sources);
      expect(partial.pricing).toEqual(ordinary.pricing);
      expect(partial.buckets).toHaveLength(2);
      expect(partial.sources.filter((source) => source.scannedFiles > 0)).toEqual([
        expect.objectContaining({ status: "ok", scannedFiles: 2, skippedFiles: 0 }),
      ]);
      expect(partial.repeatedInput?.coverageGaps).toEqual(
        expect.arrayContaining([expect.objectContaining({ reason: "unattributed", count: 1 })]),
      );
      expect(readTranscriptRecords).not.toHaveBeenCalled();
      expect(readRepeatedInputRecords).toHaveBeenCalledTimes(1);
      expect(readRepeatedInputRecords).toHaveBeenCalledWith(
        files[1]!.path,
        expect.objectContaining({ startByte: 0 }),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(testLayer, TestClock.layer()))),
  );

  it.effect("retains completed attribution when a later transcript stalls", () =>
    Effect.gen(function* () {
      const service = yield* setup;
      yield* service.refreshRates;
      const ordinary = yield* service.readSummary(input);
      const started = Promise.withResolvers<void>();
      vi.mocked(readRepeatedInputRecords)
        .mockResolvedValueOnce({
          observations: [observation],
          gaps: [],
          parserState: initialRepeatedInputParserState(),
        })
        .mockImplementationOnce(() => {
          started.resolve();
          return new Promise(() => {});
        });
      const read = yield* service
        .readSummary({ ...input, includeRepeatedInput: true })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust("12 seconds");
      const partial = yield* Fiber.join(read);
      expect(partial.buckets).toEqual(ordinary.buckets);
      expect(partial.sources).toEqual(ordinary.sources);
      expect(partial.repeatedInput?.items).toHaveLength(1);
      expect(partial.repeatedInput?.items[0]?.occurrences).toBe(1);
      expect(partial.repeatedInput?.coverageGaps).toEqual(
        expect.arrayContaining([expect.objectContaining({ reason: "unattributed" })]),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(testLayer, TestClock.layer()))),
  );
});
