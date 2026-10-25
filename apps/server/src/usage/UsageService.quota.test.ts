import * as AntigravityUsage from "../provider/Drivers/AntigravityUsage.ts";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import { MuseUsageHome } from "@t3tools/provider-muse/server";
import * as CodexUsageHistory from "./CodexUsageHistory.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { make } from "./UsageService.ts";
import { UsageDay } from "@t3tools/contracts";
import { readQuotaHistory } from "./usageQuotaHistory.ts";
import { quotaCostLedgerKey, writeQuotaCostLedger } from "./usageQuotaCostLedger.ts";

const testLayer = Layer.mergeAll(
  Layer.mock(AntigravityUsage.AntigravityUsage)({}),
  Layer.mock(CursorUsageAccounts.CursorUsageAccounts)({}),
  Layer.succeed(CodexUsageHistory.CodexUsageHistory, {
    resolve: () => Effect.succeed(new Map()),
  }),
  Layer.succeed(MuseUsageHome.MuseUsageHome, { resolve: () => Effect.succeed(undefined) }),
  ServerSettings.layerTest(),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-quota-service-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

vi.mock("./usageQuotaHistory.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./usageQuotaHistory.ts")>()),
  readQuotaHistory: vi.fn(() =>
    Effect.succeed({
      status: "ready" as const,
      source: "fixture",
      samples: [],
      message: null,
    }),
  ),
}));

describe("history-only usage requests", () => {
  it.effect("serves a closed period from the saved ledger without a transcript scan", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const offline = HttpClient.make(() => Effect.die("Closed periods must not fetch prices"));
      const baseline = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, { ...fs, exists: () => Effect.succeed(false) }),
        Effect.provideService(HttpClient.HttpClient, offline),
      );
      const input = { sinceDay: UsageDay.make("2026-07-01"), untilDay: UsageDay.make("2026-07-07"), timeZone: "UTC", providers: ["codex"] as const };
      const missing = yield* baseline.readSummary(input);
      const fingerprints = missing.sources.map((source) => source.fingerprint);
      expect(fingerprints.length).toBeGreaterThan(0);
      const interval = { id: "public-reset", sinceTime: "2026-07-03T00:00:00Z", untilTime: "2026-07-04T00:00:00Z" };
      yield* writeQuotaCostLedger(path.join(config.stateDir, "usage-quota-cost-ledger.json"), fingerprints.map((fingerprint) => ({
        key: quotaCostLedgerKey(fingerprint, "tracker-reset"), fingerprint, intervalId: "tracker-reset",
        sinceTime: interval.sinceTime, untilTime: interval.untilTime, costUsd: 123, records: 9,
        unpricedRecords: 0, recordedAt: "2026-07-05T00:00:00Z", firstRemainingPercent: 100, lastRemainingPercent: 14, resetsAt: "2026-07-04T00:00:00Z",
      })));
      const readFileString = vi.fn(fs.readFileString);
      const service = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, { ...fs, readFileString, exists: () => Effect.succeed(true) }),
        Effect.provideService(HttpClient.HttpClient, offline),
      );
      readFileString.mockClear();
      const result = yield* service.readSummary({ ...input, quotaIntervals: [interval] });
      expect(result.quotaCosts).toHaveLength(fingerprints.length);
      expect(result.quotaCosts?.every((cost) => cost.complete && cost.costUsd === 123 && cost.intervalId === interval.id)).toBe(true);
      expect(result.sources.every((source) => source.status === "ok")).toBe(true);
      expect(readFileString.mock.calls.some(([file]) => file.endsWith("usage-scan-cache.json"))).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
  it.effect("exposes bounded pricing and quota report modes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: () => Effect.succeed(false),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Offline fixture")),
        ),
      );
      const window = {
        sinceDay: UsageDay.make("2026-08-01"),
        untilDay: UsageDay.make("2026-08-30"),
        timeZone: "UTC",
      };
      const pricing = yield* service.readReport({ ...window, mode: "pricing" });
      expect(pricing.mode).toBe("pricing");
      expect(pricing.calculation.costBasis).toBe("apiEquivalent");
      const quota = yield* service.readReport({ ...window, mode: "quota", limit: 1 });
      if (quota.mode !== "quota") throw new Error("expected quota report");
      expect(quota.mode).toBe("quota");
      expect(quota.quotaHistory.status).toBe("ready");
      expect(quota.samplesTruncated).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("manual revalidation bypasses a warm summary and replaces that cache entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: () => Effect.succeed(false),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Offline fixture")),
        ),
      );
      const input = {
        sinceDay: UsageDay.make("2026-08-01"),
        untilDay: UsageDay.make("2026-08-30"),
        timeZone: "UTC",
        includeQuotaHistory: true,
      };
      vi.mocked(readQuotaHistory).mockClear();
      yield* service.readSummary(input);
      yield* service.readSummary(input);
      expect(readQuotaHistory).toHaveBeenCalledTimes(1);
      yield* service.readSummary({ ...input, refresh: true });
      expect(readQuotaHistory).toHaveBeenCalledTimes(2);
      yield* service.readSummary(input);
      expect(readQuotaHistory).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
  it.effect("returns saved history without touching transcript caches or model prices", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const readFileString = vi.fn(fs.readFileString);
      const request = vi.fn(() => Effect.die("History must not fetch model prices"));
      const service = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, { ...fs, readFileString }),
        Effect.provideService(HttpClient.HttpClient, HttpClient.make(request)),
      );
      const result = yield* service.readSummary({
        sinceDay: UsageDay.make("2026-07-01"),
        untilDay: UsageDay.make("2026-08-30"),
        timeZone: "UTC",
        quotaHistoryOnly: true,
      });
      expect(result.quotaHistory?.status).toBe("ready");
      expect(result.sources).toEqual([]);
      expect(result.buckets).toEqual([]);
      // Only the small saved Claude limit history may be read.
      expect(
        readFileString.mock.calls.map(([filePath]) => String(filePath).split(/[\\/]/).at(-1)),
      ).toEqual(["usage-claude-quota-history.json"]);
      expect(result.providerQuotaHistories?.[0]).toMatchObject({
        provider: "claude",
        status: "missing",
      });
      expect(request).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
  it.effect("excludes non-Codex sources from reset-cost queries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: () => Effect.succeed(false),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Offline fixture")),
        ),
      );
      const result = yield* service.readSummary({
        sinceDay: UsageDay.make("2026-07-01"),
        untilDay: UsageDay.make("2026-08-30"),
        timeZone: "UTC",
        quotaIntervals: [],
      });
      expect(result.sources.length).toBeGreaterThan(0);
      expect(result.sources.every((source) => source.fingerprint.provider === "codex")).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

vi.mock("./usageProviderReaders.ts", async () => {
  const Effect = await import("effect/Effect");
  return { makeProviderUsageReader: Effect.succeed(() => Effect.succeed([])) };
});
