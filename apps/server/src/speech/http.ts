import { AuthOrchestrationOperateScope, SpeechRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";
import { authenticateRawRouteWithScope } from "../http.ts";
import { proxySpeech } from "./proxy.ts";

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
    return yield* Effect.tryPromise({
      try: (signal) => proxySpeech(input, signal),
      catch: () =>
        new SpeechServiceError({
          message: "Local speech is unavailable. Check the speech router, then try again.",
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
