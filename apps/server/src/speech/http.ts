import {
  AuthOrchestrationOperateScope,
  SpeechRequest,
  ThreadId,
  type CallRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";
import { authenticateRawRouteWithScope } from "../http.ts";
import { proxySpeech, streamSpeech, SpeechUnavailableError } from "./proxy.ts";
import { ServerConfig } from "../config.ts";
import { VoiceThreadService } from "./VoiceThreadService.ts";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { CallService, verifyCallModel } from "./callService.ts";
import { callStore } from "./callStore.ts";
import { callOperator } from "./callOperator.ts";
import { AuxiliaryProviderSessions } from "../provider/AuxiliaryProviderSessions.ts";

const decodeSpeechRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(SpeechRequest));

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
    const providers = yield* ProviderRegistry;
    const providerService = yield* AuxiliaryProviderSessions;
    const calls = new CallService(
      callStore(config.stateDir),
      {
        verify: async (options) => {
          const snapshot = await Effect.runPromise(engine.snapshot(options.threadId));
          if (!snapshot.projection.thread || snapshot.projection.thread.archivedAt)
            throw new Error("Open an existing chat before starting a call.");
          verifyCallModel(options, await Effect.runPromise(providers.getProviders));
          return {
            runtimeMode: snapshot.projection.thread.runtimeMode,
            interactionMode: snapshot.projection.thread.interactionMode,
          };
        },
        dispatch: (command) => Effect.runPromise(engine.dispatch(command)),
        verifyVoice: async (selection) => {
          const caps = await Effect.runPromise(
            providerService.getInstanceInfo(selection.instanceId),
          );
          if (caps.driverKind !== "claudeAgent")
            throw new Error(
              "This provider does not support tool-free voice sessions. It can still run as the background agent.",
            );
        },
        speech: proxySpeech,
        speechStream: streamSpeech,
        tenants: [
          process.env.T3_CALL_STT_TENANT ?? "whisper-large-v3-turbo",
          process.env.T3_CALL_TTS_TENANT ?? "breeze-tts-2",
        ],
        ttsModel: process.env.T3_CALL_TTS_MODEL ?? "breeze-tts-2",
      },
      callOperator(config.stateDir),
    );
    if ("callId" in input && input.action === "call.speak" && input.streamAudio) {
      const controller = new AbortController();
      const body = Stream.fromAsyncIterable(
        calls.speakStream(input, controller.signal),
        () => new Error("Speech stream interrupted."),
      ).pipe(
        Stream.catch(() =>
          Stream.succeed({ error: "Speech stream interrupted. Saved speech is retained." }),
        ),
        Stream.map((chunk) => new TextEncoder().encode(`${JSON.stringify(chunk)}\n`)),
        Stream.ensuring(Effect.sync(() => controller.abort())),
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
            cause instanceof SpeechUnavailableError ||
            cause instanceof TypeError ||
            (cause instanceof Error && cause.name === "TimeoutError"),
          message:
            cause instanceof Error
              ? cause.message
              : "Call unavailable. Saved speech is retained. Try reconnecting.",
        }),
    }).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
      Effect.catch((error) =>
        Effect.succeed(
          HttpServerResponse.text(error.message, { status: error.recoverable ? 503 : 409 }),
        ),
      ),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
    Effect.catch(() =>
      Effect.succeed(HttpServerResponse.text("Invalid speech request.", { status: 400 })),
    ),
  ),
);
