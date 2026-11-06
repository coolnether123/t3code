import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  EnvironmentHttpApi,
  EnvironmentVoiceBodyLimit,
  SPEECH_MAX_OPTIONS_BYTES,
  SpeechRequest,
  type CallRequest,
} from "@t3tools/contracts";
import { decodeSpeechPcmRequest } from "@t3tools/shared/speech";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse, HttpServerRespondable } from "effect/http";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SpeechPostProcessing from "./postProcessing.ts";
import * as SpeechService from "./SpeechService.ts";
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
const MAX_TRANSCRIBE_BODY_BYTES = SpeechService.MAX_SPEECH_BYTES + SPEECH_MAX_OPTIONS_BYTES + 4;
const parseAudio = Option.liftThrowable(decodeSpeechPcmRequest);

const bodyLimit = Layer.succeed(EnvironmentVoiceBodyLimit, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers["content-length"]) > MAX_TRANSCRIBE_BODY_BYTES)
      return yield* failEnvironmentInvalidRequest("invalid_audio");
    return yield* effect.pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.bytes(MAX_TRANSCRIBE_BODY_BYTES),
      ),
    );
  }),
);

const mapSpeechError = <A, R>(effect: Effect.Effect<A, SpeechService.SpeechError, R>) =>
  effect.pipe(
    Effect.catchTags({
      SpeechInvalidAudioError: () => failEnvironmentInvalidRequest("invalid_audio"),
      SpeechUnsupportedPlatformError: () => failEnvironmentInvalidRequest("speech_unavailable"),
      SpeechBusyError: () => failEnvironmentInvalidRequest("speech_busy"),
      SpeechDownloadCancelledError: () => failEnvironmentInvalidRequest("speech_busy"),
      SpeechModelNotFoundError: () => failEnvironmentInvalidRequest("invalid_command"),
      SpeechOperationError: (error) => failEnvironmentInternal("internal_error", error),
    }),
  );

export const speechHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const speech = yield* SpeechService.SpeechService;
    const postProcessing = yield* SpeechPostProcessing.SpeechPostProcessing;
    const guard = Effect.fnUntraced(function* (
      endpoint: string,
      scope: AuthEnvironmentScope = AuthOrchestrationOperateScope,
    ) {
      yield* annotateEnvironmentRequest(endpoint);
      yield* requireEnvironmentScope(scope);
    });
    return handlers
      .handle(
        "status",
        Effect.fn("environment.voice.status")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* speech.status.pipe(mapSpeechError);
        }),
      )
      .handle(
        "prepareModel",
        Effect.fn("environment.voice.prepareModel")(function* (args) {
          yield* guard(args.endpoint.name);
          yield* speech.prepareModel.pipe(mapSpeechError);
        }),
      )
      .handle(
        "models",
        Effect.fn("environment.voice.models")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* speech.models(args.query.benchmarks === "1").pipe(mapSpeechError);
        }),
      )
      .handle(
        "downloadModel",
        Effect.fn("environment.voice.downloadModel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.downloadModel(args.payload.modelId).pipe(mapSpeechError);
        }),
      )
      .handle(
        "selectModel",
        Effect.fn("environment.voice.selectModel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.selectModel(args.payload.modelId).pipe(mapSpeechError);
        }),
      )
      .handle(
        "cancelModelDownload",
        Effect.fn("environment.voice.cancelModelDownload")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.cancelDownload(args.payload.modelId).pipe(mapSpeechError);
        }),
      )
      .handle(
        "removeModel",
        Effect.fn("environment.voice.removeModel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.removeModel(args.payload.modelId).pipe(mapSpeechError);
        }),
      )
      .handle(
        "updateAcceleration",
        Effect.fn("environment.voice.updateAcceleration")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.updateAcceleration(args.payload.acceleration).pipe(mapSpeechError);
        }),
      )
      .handle(
        "updateModelUnloadTimeout",
        Effect.fn("environment.voice.updateModelUnloadTimeout")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.updateModelUnloadTimeout(args.payload.timeout).pipe(mapSpeechError);
        }),
      )
      .handle(
        "transcribe",
        Effect.fn("environment.voice.transcribe")(function* (args) {
          yield* guard(args.endpoint.name);
          const decoded = parseAudio(args.payload);
          if (Option.isNone(decoded)) return yield* failEnvironmentInvalidRequest("invalid_audio");
          const text = yield* speech
            .transcribe(decoded.value.pcm, decoded.value.options)
            .pipe(mapSpeechError);
          return { text };
        }),
      )
      .handle(
        "postProcess",
        Effect.fn("environment.voice.postProcess")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* postProcessing
            .process(args.payload)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }),
      );
  }),
).pipe(Layer.provide(bodyLimit), Layer.provide(SpeechPostProcessing.layer));
