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
import type { HttpClient } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechResponse));
const encode = Schema.encodeSync(Schema.fromJsonString(SpeechRequest));
export class VoiceRequestError extends Error {
  readonly recoverable: boolean;
  constructor(message: string, recoverable: boolean) {
    super(message);
    this.recoverable = recoverable;
  }
}

/** Reuse cookie, desktop bearer and refreshed request-bound relay authorization. */
export const fetchEnvironmentSpeech = Effect.fn("voice.fetchEnvironmentSpeech")(function* (input: {
  prepared: PreparedConnection;
  signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  request: SpeechRequest;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}) {
  const result = yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "POST",
    timeoutMs: 100_000,
    url: (base) => new URL("/api/voice", base).toString(),
    request: ({ headers, url }) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await (input.fetcher ?? fetch)(url, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            credentials: headers.authorization ? "omit" : "include",
            redirect: "error",
            signal: AbortSignal.any([signal, input.signal]),
            body: encode(input.request),
          });
          return { status: response.status, text: await response.text() };
        },
        catch: (cause) =>
          new RemoteEnvironmentAuthFetchError({
            message: "Cannot reach this chat's environment. Speech remains queued on this device.",
            cause,
          }),
      }),
    isUnauthorizedResponse: (response) => response.status === 401,
  });
  return yield* Effect.try({
    try: () => {
      if (result.status < 200 || result.status >= 300)
        throw new VoiceRequestError(
          result.status === 404
            ? "This environment needs the voice update."
            : result.text.slice(0, 600) || "Voice request failed.",
          result.status === 503 || result.status >= 500,
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
    execute: (input: { request: SpeechRequest; signal: AbortSignal }) =>
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
