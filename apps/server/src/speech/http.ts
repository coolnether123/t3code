import { AuthOrchestrationOperateScope, SpeechRequest, type CallRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";
import { authenticateRawRouteWithScope } from "../http.ts";
import { proxySpeech, streamSpeech, speechInputMode, SpeechUnavailableError } from "./proxy.ts";
import { ServerConfig } from "../config.ts";
import { VoiceThreadService } from "./VoiceThreadService.ts";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { CallService, verifyCallModel } from "./callService.ts";
import { callStore } from "./callStore.ts";
import { callOperator } from "./callOperator.ts";
import { AuxiliaryProviderSessions } from "../provider/AuxiliaryProviderSessions.ts";

const decodeSpeechRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(SpeechRequest));
const isSpeechUnavailableError = Schema.is(SpeechUnavailableError);

class SpeechServiceError extends Schema.TaggedError<SpeechServiceError>()("SpeechServiceError", {
  message: Schema.String,
  recoverable: Schema.Boolean,
}) {}

export const speechRouteLayer = HttpRouter.add(
  "POST",
  "/api/voice",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* request.text;
    if (text.length > 16_000_000)
      return HttpServerResponse.text("Recording too large.", { status: 413 });
    const input = yield* decodeSpeechRequest(text);
    const config = yield* ServerConfig;
    const engine = yield* VoiceThreadService;
    if (input.action === "otis.open")
      return HttpServerResponse.jsonUnsafe({ threadId: yield* engine.openOtis() });
    const providers = yield* ProviderRegistry;
    const providerService = yield* AuxiliaryProviderSessions;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const sttTenant = yield* Config.String("T3_CALL_STT_TENANT").pipe(
      Config.withDefault("whisper-large-v3-turbo"),
    );
    const ttsTenant = yield* Config.String("T3_CALL_TTS_TENANT").pipe(
      Config.withDefault("breeze-tts-2"),
    );
    const ttsModel = yield* Config.String("T3_CALL_TTS_MODEL").pipe(
      Config.withDefault("breeze-tts-2"),
    );
    const forceDevice =
      (yield* Config.String("T3_CALL_FORCE_DEVICE_STT").pipe(Config.withDefault(""))) === "1";
    const calls = new CallService(
      callStore(config.stateDir),
      {
        verify: async (options) => {
          const snapshot = await runPromise(engine.snapshot(options.threadId));
          if (!snapshot.projection.thread || snapshot.projection.thread.archivedAt)
            throw new Error("Open an existing chat before starting a call.");
          verifyCallModel(options, await runPromise(providers.getProviders));
          return {
            runtimeMode: snapshot.projection.thread.runtimeMode,
            interactionMode: snapshot.projection.thread.interactionMode,
          };
        },
        dispatch: (command) => runPromise(engine.dispatch(command)),
        verifyVoice: async (selection) => {
          const caps = await runPromise(providerService.getInstanceInfo(selection.instanceId));
          if (caps.driverKind !== "claudeAgent")
            throw new Error(
              "This provider does not support tool-free voice sessions. It can still run as the background agent.",
            );
        },
        speech: proxySpeech,
        inputMode: (signal) => speechInputMode(signal, sttTenant, forceDevice),
        speechStream: streamSpeech,
        tenants: [sttTenant, ttsTenant],
        ttsModel,
      },
      callOperator(config.stateDir),
    );
    if ("callId" in input && input.action === "call.speak" && input.streamAudio) {
      const body = Stream.unwrap(
        Effect.gen(function* () {
          const signal = yield* Effect.abortSignal;
          return Stream.fromAsyncIterable(
            calls.speakStream(input, signal),
            () =>
              new SpeechServiceError({ message: "Speech stream interrupted.", recoverable: true }),
          );
        }),
      ).pipe(
        Stream.catch(() =>
          Stream.succeed({ error: "Speech stream interrupted. Saved speech is retained." }),
        ),
        Stream.map((chunk) =>
          new TextEncoder().encode(
            `${JSON.stringify({
              ...chunk,
              ...(input.generation ? { generation: input.generation } : {}),
              speechId: input.speechId,
            })}\n`,
          ),
        ),
      );
      return HttpServerResponse.stream(body, {
        headers: {
          "content-type": "application/x-ndjson",
          "content-encoding": "identity",
          "cache-control": "no-store, no-transform",
          "x-accel-buffering": "no",
        },
      });
    }
    return yield* Effect.tryPromise({
      try: (signal) =>
        "callId" in input ? calls.handle(input as CallRequest, signal) : proxySpeech(input, signal),
      catch: (cause) =>
        new SpeechServiceError({
          recoverable:
            isSpeechUnavailableError(cause) ||
            cause instanceof TypeError ||
            (cause instanceof Error && cause.name === "TimeoutError"),
          message:
            cause instanceof Error
              ? cause.message
              : "Call unavailable. Saved speech is retained. Try reconnecting.",
        }),
    }).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
      Effect.orElseSucceed((error) =>
        HttpServerResponse.text(error.message, { status: error.recoverable ? 503 : 409 }),
      ),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
    Effect.orElseSucceed(() => HttpServerResponse.text("Invalid speech request.", { status: 400 })),
  ),
);
