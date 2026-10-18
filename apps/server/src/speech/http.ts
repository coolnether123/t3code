import { AuthOrchestrationOperateScope, SpeechRequest, ThreadId, type CallRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";
import { authenticateRawRouteWithScope } from "../http.ts";
import { proxySpeech } from "./proxy.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { CallService, verifyCallModel } from "./callService.ts";
import { callStore } from "./callStore.ts";

const decodeSpeechRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(SpeechRequest));

class SpeechServiceError extends Schema.TaggedErrorClass<SpeechServiceError>()(
  "SpeechServiceError",
  {
    message: Schema.String,
  },
) {}

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
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const providers = yield* ProviderRegistry;
    const calls = new CallService(callStore(config.stateDir), {
      verify: async (options) => {
        const snapshot = await Effect.runPromise(projections.getThreadDetailSnapshot(ThreadId.make(options.threadId), { turnLimit: 1 }));
        if (Option.isNone(snapshot) || snapshot.value.thread.archivedAt) throw new Error("Open an existing chat before starting a call.");
        verifyCallModel(options, await Effect.runPromise(providers.getProviders));
      },
      dispatch: (command) => Effect.runPromise(engine.dispatch(command)),
      speech: proxySpeech,
      tenants: [process.env.T3_CALL_STT_TENANT ?? "whisper-large-v3-turbo", process.env.T3_CALL_TTS_TENANT ?? "breeze-tts-2"],
      ttsModel: process.env.T3_CALL_TTS_MODEL ?? "breeze-tts-2",
    });
    return yield* Effect.tryPromise({
      try: (signal) => "callId" in input
        ? calls.handle(input as CallRequest, signal)
        : proxySpeech(input, signal),
      catch: (cause) =>
        new SpeechServiceError({
          message: cause instanceof Error ? cause.message : "Call unavailable. Saved speech is retained. Try reconnecting.",
        }),
    }).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
      Effect.catch((error) =>
        Effect.succeed(HttpServerResponse.text(error.message, { status: 503 })),
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
