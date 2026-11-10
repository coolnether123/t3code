import { CodexSettings } from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Semaphore from "effect/Semaphore";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerConfig } from "../config.ts";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { appendCodexQuotaSampleFile, codexWeeklyQuotaSample } from "./codexQuotaSampler.ts";

export const CODEX_CREDIT_HISTORY_FILE = "usage-codex-quota-history.json";
const decodeSettings = Schema.decodeUnknownEffect(CodexSettings);

export class CodexCreditSampler extends Context.Service<
  CodexCreditSampler,
  {
    readonly sampleNow: Effect.Effect<void>;
  }
>()("t3/usage/CodexCreditSampler") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettingsService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const lock = yield* Semaphore.make(1);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sampleNow = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const instance = Object.values(settings.providerInstances).find(
      (entry) => String(entry.driver) === "codex",
    );
    const codex = yield* decodeSettings(instance?.config ?? {});
    const { client } = yield* withCodexAppServerClient({
      binaryPath: codex.binaryPath,
      homePath: codex.homePath,
      launchArgs: codex.launchArgs,
      useDesktopAppDaemon: codex.useDesktopAppDaemon,
      cwd: config.cwd,
    });
    const response = yield* client.request("account/rateLimits/read", null);
    const now = yield* Clock.currentTimeMillis;
    const sample = codexWeeklyQuotaSample(response, DateTime.formatIso(DateTime.makeUnsafe(now)));
    if (sample === null) return;
    yield* Effect.tryPromise(() =>
      appendCodexQuotaSampleFile(path.join(config.stateDir, CODEX_CREDIT_HISTORY_FILE), sample),
    );
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.scoped,
    Effect.timeout("30 seconds"),
    lock.withPermits(1),
  );

  yield* Effect.gen(function* () {
    yield* Effect.sleep("45 seconds");
    while (true) {
      const settings = yield* settingsService.getSettings;
      const snapshot = yield* backgroundPolicy.snapshot;
      if (
        !BackgroundPolicy.isHostConstrained(
          snapshot.hostPower,
          resolveServerBackgroundActivitySettings(settings),
        )
      ) {
        yield* sampleNow.pipe(
          Effect.catchCause(() => Effect.logDebug("Codex credit reading unavailable.")),
        );
      }
      yield* Effect.sleep("5 minutes");
    }
  }).pipe(Effect.forkScoped);
  return { sampleNow: sampleNow.pipe(Effect.ignoreCause) };
});

export const layer = Layer.effect(CodexCreditSampler, make);
