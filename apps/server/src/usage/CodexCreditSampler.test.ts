import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ServerConfig from "../config.ts";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CODEX_CREDIT_HISTORY_FILE, make } from "./CodexCreditSampler.ts";
import { decodeQuotaHistory } from "./usageQuotaHistory.ts";

vi.mock("../provider/CodexProvider.ts", () => ({ withCodexAppServerClient: vi.fn() }));

describe("CodexCreditSampler", () => {
  it.effect("persists live balance changes using only read calls", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(Date.parse("2026-11-10T09:00:00Z"));
      let balance = "49537.6424375";
      const request = vi.fn(() =>
        Effect.succeed({
          rateLimits: {
            limitId: "codex",
            secondary: { usedPercent: 97, resetsAt: 1794646800, windowDurationMins: 10080 },
            credits: { hasCredits: true, unlimited: false, balance },
          },
        }),
      );
      vi.mocked(withCodexAppServerClient)
        .mockReset()
        .mockReturnValue(
          Effect.succeed({ client: { request }, initialize: {} }) as unknown as ReturnType<
            typeof withCodexAppServerClient
          >,
        );
      const sampler = yield* make.pipe(
        Effect.provide(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
      );
      yield* sampler.sampleNow;
      yield* TestClock.adjust("1 second");
      balance = "49530.125";
      yield* sampler.sampleNow;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const result = decodeQuotaHistory(
        JSON.parse(yield* fs.readFileString(path.join(config.stateDir, CODEX_CREDIT_HISTORY_FILE))),
      );
      expect(result.samples.map((sample) => sample.credits?.balance)).toEqual([
        "49537.6424375",
        "49530.125",
      ]);
      expect(request.mock.calls).toEqual([
        ["account/rateLimits/read", null],
        ["account/rateLimits/read", null],
      ]);
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({}).pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "codex-credit-sampler" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("retries scheduled readings after settings and provider failures", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(Date.parse("2026-11-10T09:00:00Z"));
      let settingsReads = 0;
      const settings = yield* ServerSettings.ServerSettingsService;
      const hostPower = yield* (yield* HostPowerMonitor.make()).snapshot;
      const request = vi
        .fn()
        .mockReturnValueOnce(Effect.fail("offline"))
        .mockReturnValue(
          Effect.succeed({
            rateLimits: {
              limitId: "codex",
              secondary: { usedPercent: 37, resetsAt: 1794646800, windowDurationMins: 10080 },
            },
          }),
        );
      vi.mocked(withCodexAppServerClient)
        .mockReset()
        .mockReturnValue(
          Effect.succeed({ client: { request }, initialize: {} }) as unknown as ReturnType<
            typeof withCodexAppServerClient
          >,
        );
      yield* make.pipe(
        Effect.provideService(ServerSettings.ServerSettingsService, {
          ...settings,
          getSettings: Effect.suspend(() =>
            ++settingsReads === 1
              ? Effect.die("settings unavailable")
              : Effect.succeed(DEFAULT_SERVER_SETTINGS),
          ),
        }),
        Effect.provide(
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            snapshot: Effect.succeed({
              hostPower,
              leases: [],
              activeForegroundLeaseCount: 0,
              activeScopeKeys: [],
              shouldRunOpportunisticWork: false,
              updatedAt: hostPower.updatedAt,
            }),
          }),
        ),
      );
      yield* TestClock.adjust("45 seconds");
      expect(request).not.toHaveBeenCalled();
      yield* TestClock.adjust("5 minutes");
      expect(request).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust("5 minutes");
      expect(request).toHaveBeenCalledTimes(2);
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({}).pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "codex-credit-sampler" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
  );
});
