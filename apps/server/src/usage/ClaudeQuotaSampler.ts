/**
 * ClaudeQuotaSampler — saves Claude subscription readings for the usage
 * reset monitor, the way the Codex Limits collector does for Codex.
 *
 * Reads the account's session and weekly windows on the provider health-check
 * interval while background work is allowed, whether or not Claude is enabled
 * for chats, and appends them to `usage-claude-quota-history.json`. A reading
 * never sends a prompt. While readings are unavailable (for example, the CLI
 * is signed out) it retries on a slower cadence instead of spawning the CLI
 * every interval.
 *
 * @module usage/ClaudeQuotaSampler
 */
import {
  ClaudeSettings,
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerConfig } from "../config.ts";
import { readClaudeSubscriptionWindows } from "../provider/Layers/ClaudeProvider.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  appendClaudeQuotaReadings,
  CLAUDE_QUOTA_HISTORY_FILE,
  decodeClaudeQuotaHistory,
  emptyClaudeQuotaHistory,
  markClaudeQuotaUnavailable,
  type ClaudeQuotaHistoryDocument,
} from "./claudeQuotaHistory.ts";

/** Retry cadence while Claude cannot report limits, e.g. a signed-out CLI. */
const UNAVAILABLE_RETRY = Duration.minutes(30);
/** Let server startup settle before the first CLI spawn. */
const FIRST_READING_DELAY = Duration.seconds(45);

const HistoryJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeHistoryJson = Schema.decodeUnknownEffect(HistoryJson);
const encodeHistoryJson = Schema.encodeEffect(HistoryJson);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

export class ClaudeQuotaSampler extends Context.Service<
  ClaudeQuotaSampler,
  {
    /** Takes one reading now. Never fails; failures are saved as the reason. */
    readonly sampleNow: Effect.Effect<void>;
  }
>()("t3/usage/ClaudeQuotaSampler") {}

/** The first Claude instance's settings, falling back to the built-in provider's. */
const claudeSettingsFor = (settings: ServerSettings) =>
  Effect.gen(function* () {
    for (const instance of Object.values(settings.providerInstances)) {
      if (String(instance.driver) !== "claudeAgent") continue;
      const decoded = yield* decodeClaudeSettings(instance.config ?? {}).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (decoded !== null) return decoded;
    }
    return settings.providers.claudeAgent;
  });

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const historyPath = path.join(config.stateDir, CLAUDE_QUOTA_HISTORY_FILE);
  const lock = yield* Semaphore.make(1);

  const readHistory = fileSystem.readFileString(historyPath).pipe(
    Effect.flatMap((text) => decodeHistoryJson(text)),
    Effect.map(decodeClaudeQuotaHistory),
    Effect.orElseSucceed((): ClaudeQuotaHistoryDocument => emptyClaudeQuotaHistory),
  );

  const sampleNow = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const claudeSettings = yield* claudeSettingsFor(settings);
    const reading = yield* readClaudeSubscriptionWindows(claudeSettings);
    const observedAtMs = yield* Clock.currentTimeMillis;
    const prior = yield* readHistory;
    const next =
      reading._tag === "Windows"
        ? appendClaudeQuotaReadings(prior, reading.windows, observedAtMs)
        : markClaudeQuotaUnavailable(prior, reading.reason, observedAtMs);
    const contents = yield* encodeHistoryJson(next);
    yield* writeFileStringAtomically({ filePath: historyPath, contents });
    return reading._tag === "Windows";
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    lock.withPermits(1),
    Effect.withSpan("ClaudeQuotaSampler.sample"),
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );

  const loop = Effect.gen(function* () {
    yield* Effect.sleep(FIRST_READING_DELAY);
    let available = true;
    while (true) {
      const shouldRun = yield* backgroundPolicy.shouldRunScopeWork({ type: "provider-status" });
      if (shouldRun) {
        available = yield* sampleNow.pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("Claude quota reading failed", { cause }).pipe(Effect.as(false)),
          ),
        );
      }
      const wait = available ? yield* interval : UNAVAILABLE_RETRY;
      yield* Effect.sleep(Duration.toMillis(wait) <= 0 ? Duration.seconds(60) : wait);
    }
  });
  yield* Effect.forkScoped(loop);

  return {
    sampleNow: sampleNow.pipe(Effect.asVoid, Effect.ignoreCause({ log: true })),
  } satisfies ClaudeQuotaSampler["Service"];
});

export const layer = Layer.effect(ClaudeQuotaSampler, make);
