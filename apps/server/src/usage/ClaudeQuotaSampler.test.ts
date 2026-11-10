import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import { readClaudeSubscriptionWindows } from "../provider/ClaudeProvider.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeQuotaSampler from "./ClaudeQuotaSampler.ts";
import {
  appendClaudeQuotaReadings,
  CLAUDE_QUOTA_HISTORY_FILE,
  claudeQuotaHistories,
  decodeClaudeQuotaHistory,
  emptyClaudeQuotaHistory,
} from "./claudeQuotaHistory.ts";

vi.mock("../provider/ClaudeProvider.ts", () => ({ readClaudeSubscriptionWindows: vi.fn() }));

describe("ClaudeQuotaSampler", () => {
  it.effect("refreshes persisted cycles without a connected client", () =>
    Effect.gen(function* () {
      const now = Date.parse("2026-11-08T09:00:00.000Z");
      yield* TestClock.adjust(now);
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const historyPath = path.join(config.stateDir, CLAUDE_QUOTA_HISTORY_FILE);
      const written = yield* Queue.unbounded<void>();
      const window = {
        id: "seven_day",
        label: "Weekly",
        kind: "weekly" as const,
        usedPercent: 10,
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 60_000)),
      };
      const old = appendClaudeQuotaReadings(
        emptyClaudeQuotaHistory,
        [{ ...window, resetsAt: "2026-10-22T08:00:00.000Z" }],
        Date.parse("2026-10-19T15:09:00.000Z"),
      );
      yield* fs.writeFileString(historyPath, JSON.stringify(old));
      const read = vi.mocked(readClaudeSubscriptionWindows).mockReset();
      read.mockReturnValueOnce(Effect.succeed({ _tag: "Windows", windows: [window] }));
      read.mockReturnValueOnce(
        Effect.succeed({
          _tag: "Windows",
          windows: [{ ...window, usedPercent: 0, resetsAt: "2026-11-15T09:01:00.000Z" }],
        }),
      );
      const policy = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        snapshot: Effect.succeed({
          hostPower: {
            source: "unknown",
            idle: "unknown",
            idleSeconds: null,
            locked: "unknown",
            suspended: false,
            onBattery: "unknown",
            lowPowerMode: "unknown",
            thermalState: "unknown",
            stale: true,
            updatedAt: DateTime.makeUnsafe(now),
          },
          leases: [],
          activeForegroundLeaseCount: 0,
          activeScopeKeys: [],
          shouldRunOpportunisticWork: false,
          updatedAt: DateTime.makeUnsafe(now),
        }),
      });
      yield* ClaudeQuotaSampler.make.pipe(
        Effect.provide(policy),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            fs
              .rename(from, to)
              .pipe(
                Effect.tap(() =>
                  to === historyPath ? Queue.offer(written, undefined) : Effect.void,
                ),
              ),
        }),
      );
      expect(read).not.toHaveBeenCalled();
      yield* TestClock.adjust("45 seconds");
      yield* Queue.take(written);
      const first = decodeClaudeQuotaHistory(JSON.parse(yield* fs.readFileString(historyPath)));
      expect(claudeQuotaHistories(first)[0]?.samples.at(-1)?.resetsAt).toBe(window.resetsAt);
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(written);
      const second = decodeClaudeQuotaHistory(JSON.parse(yield* fs.readFileString(historyPath)));
      expect(claudeQuotaHistories(second)[0]?.samples.map((sample) => sample.resetsAt)).toEqual([
        "2026-10-22T08:00:00.000Z",
        window.resetsAt,
        "2026-11-15T09:01:00.000Z",
      ]);
      expect(read).toHaveBeenCalledTimes(2);
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({ backgroundActivity: { profile: "performance" } }).pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "claude-quota-sampler" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
  );
});
