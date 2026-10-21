import { SpeechResponse, SpeechRequest } from "@t3tools/contracts";
import type { PreparedConnection } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
import { createEnvironmentCommand } from "../state/runtime.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/http";
import type { Atom } from "effect/reactivity";
import { VoiceRequestError, voiceRequestError } from "./errors.ts";
import { voiceRequestTimeoutMs } from "./timeouts.ts";
export { VoiceRequestError } from "./errors.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechResponse));
const encode = Schema.encodeSync(Schema.fromJsonString(SpeechRequest));
const encodeResponse = Schema.encodeSync(Schema.fromJsonString(SpeechResponse));
/** Reuse cookie, desktop bearer and refreshed request-bound relay authorization. */
export const fetchEnvironmentSpeech = Effect.fn("voice.fetchEnvironmentSpeech")(function* (input: {
  onAudio?: (chunk: { audio: string; sampleRate: number }) => void;
  prepared: PreparedConnection;
  signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  request: SpeechRequest;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}) {
  const body = yield* Effect.try({
    try: () => encode(input.request),
    catch: () =>
      new VoiceRequestError("Local voice request validation failed. This is a client bug.", false),
  });
  // The voice route streams NDJSON outside the typed HTTP API, so it is signed and fetched by URL.
  // A refreshed relay credential can move the environment, so each attempt resolves it again.
  let voiceUrl = "";
  const result = yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "POST",
    timeoutMs: voiceRequestTimeoutMs(
      input.request.action,
      "streamAudio" in input.request && input.request.streamAudio,
    ),
    url: (urls) => {
      voiceUrl = new URL("/api/voice", urls.shellSnapshot()).toString();
      return voiceUrl;
    },
    request: ({ headers }) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await (input.fetcher ?? fetch)(voiceUrl, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            credentials: headers.authorization ? "omit" : "include",
            redirect: "error",
            signal: AbortSignal.any([signal, input.signal]),
            body,
          });
          if (
            response.ok &&
            input.onAudio &&
            response.headers.get("content-type")?.includes("application/x-ndjson")
          ) {
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let partial = "";
            const result: typeof SpeechResponse.Type = {};
            try {
              for (;;) {
                const chunk = await reader.read();
                partial += decoder.decode(chunk.value, { stream: !chunk.done });
                const lines = partial.split("\n");
                partial = lines.pop()!;
                for (const line of lines) {
                  if (!line.trim()) continue;
                  const frame = decode(line);
                  if (frame.error) throw new VoiceRequestError(frame.error, true);
                  if (frame.audio && frame.sampleRate) {
                    try {
                      input.onAudio({ audio: frame.audio, sampleRate: frame.sampleRate });
                    } catch {
                      throw new VoiceRequestError(
                        "Audio playback could not start. Check the audio device, then retry.",
                        false,
                      );
                    }
                  } else Object.assign(result, frame);
                }
                if (chunk.done) break;
              }
              if (partial.trim() || !result.complete)
                throw new VoiceRequestError("Speech stream ended before completion.", true);
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
            return {
              status: response.status,
              text: encodeResponse(result),
            };
          }
          return { status: response.status, text: await response.text() };
        },
        catch: (cause) =>
          cause instanceof VoiceRequestError
            ? cause
            : cause instanceof SyntaxError || Schema.isSchemaError(cause)
              ? new VoiceRequestError("Speech service returned invalid audio frames.", false)
              : new RemoteEnvironmentAuthFetchError({
                  message:
                    "Cannot reach this chat's environment. Speech remains queued on this device.",
                  cause,
                }),
      }),
    isUnauthorizedResponse: (response) => response.status === 401,
  }).pipe(Effect.mapError(voiceRequestError));
  return yield* Effect.try({
    try: () => {
      if (result.status < 200 || result.status >= 300)
        throw new VoiceRequestError(
          result.status === 404
            ? "This environment needs the voice update."
            : result.text.slice(0, 600) || "Voice request failed.",
          result.status === 408 || result.status === 429 || result.status >= 500,
        );
      return decode(result.text);
    },
    catch: (cause) =>
      cause instanceof VoiceRequestError
        ? cause
        : new VoiceRequestError(
            "The environment returned an invalid voice response. Saved speech is retained.",
            false,
          ),
  });
});

export function createVoiceRequestCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "voice-request",
    execute: (input: {
      request: SpeechRequest;
      signal: AbortSignal;
      onAudio?: (chunk: { audio: string; sampleRate: number }) => void;
    }) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared))
          return yield* Effect.fail(
            new VoiceRequestError(
              "This environment is disconnected. Speech remains queued on this device.",
              true,
            ),
          );
        return yield* fetchEnvironmentSpeech({
          ...input,
          prepared: prepared.value,
          signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
          remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
        });
      }),
  });
}
