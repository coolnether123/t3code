import { CodexSettings } from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Semaphore from "effect/Semaphore";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerConfig } from "../config.ts";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  appendCodexQuotaSampleFile,
  CodexQuotaHistoryError,
  readCodexWeeklyQuota,
} from "./codexQuotaSampler.ts";

class CodexQuotaWriteError extends Schema.TaggedError<CodexQuotaWriteError>()(
  "CodexQuotaWriteError",
  { cause: Schema.Defect() },
) {}

export const CODEX_CREDIT_HISTORY_FILE = "usage-codex-quota-history.json";
const decodeSettings = Schema.decodeUnknownEffect(CodexSettings);
const isQuotaHistoryError = Schema.is(CodexQuotaHistoryError);

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
  const sample = Effect.fn("CodexCreditSampler.sample")(
    function* (scheduled: boolean) {
      let stage = "settings";
      yield* Effect.gen(function* () {
        const settings = yield* settingsService.getSettings;
        if (scheduled) {
          stage = "host-policy";
          const { hostPower } = yield* backgroundPolicy.snapshot;
          if (
            BackgroundPolicy.isHostConstrained(
              hostPower,
              resolveServerBackgroundActivitySettings(settings),
            )
          ) {
            yield* Effect.logDebug("Codex quota sample deferred by host policy");
            return;
          }
        }
        stage = "provider-settings";
        const instance = Object.values(settings.providerInstances).find(
          (entry) => String(entry.driver) === "codex",
        );
        const codex = yield* decodeSettings(instance?.config ?? {});
        const response = yield* Effect.gen(function* () {
          stage = "app-server-initialize";
          const { client } = yield* withCodexAppServerClient({
            binaryPath: codex.binaryPath,
            homePath: codex.homePath,
            launchArgs: codex.launchArgs,
            useDesktopAppDaemon: codex.useDesktopAppDaemon,
            cwd: config.cwd,
          });
          stage = "rate-limits-read";
          return yield* client.request("account/rateLimits/read", null);
        }).pipe(Effect.scoped, Effect.timeout("30 seconds"));
        stage = "weekly-window";
        const now = yield* Clock.currentTimeMillis;
        const reading = readCodexWeeklyQuota(
          response,
          DateTime.formatIso(DateTime.makeUnsafe(now)),
        );
        if (typeof reading === "string") {
          yield* Effect.logWarning("Codex quota sample unavailable", { stage, reason: reading });
          return;
        }
        stage = "history-write";
        yield* Effect.tryPromise({
          try: () =>
            appendCodexQuotaSampleFile(
              path.join(config.stateDir, CODEX_CREDIT_HISTORY_FILE),
              reading,
            ),
          catch: (cause) => new CodexQuotaWriteError({ cause }),
        });
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
          const rpcCode = error?._tag === "CodexAppServerRequestError" ? error.code : undefined;
          const fileError = error?._tag === "CodexQuotaWriteError" ? error.cause : undefined;
          const fileCode = (fileError as NodeJS.ErrnoException | undefined)?.code;
          const reason = isQuotaHistoryError(fileError)
            ? fileError.reason
            : (error?._tag ?? "unexpected-error");
          return Effect.logWarning("Codex quota sample failed", {
            stage,
            reason,
            ...(rpcCode === undefined ? {} : { rpcCode }),
            ...(typeof fileCode === "string" && /^E[A-Z]+$/u.test(fileCode) ? { fileCode } : {}),
          });
        }),
      );
    },
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    lock.withPermits(1),
  );

  yield* Effect.gen(function* () {
    yield* Effect.sleep("45 seconds");
    while (true) {
      yield* sample(true);
      yield* Effect.sleep("5 minutes");
    }
  }).pipe(Effect.forkScoped);
  return { sampleNow: sample(false) };
});

export const layer = Layer.effect(CodexCreditSampler, make);
