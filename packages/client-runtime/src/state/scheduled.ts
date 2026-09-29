import {
  CodexDesktopThreadHistoryResponse,
  CodexScheduledRoutineListResponse,
  CodexScheduledRunListResponse,
  EnvironmentAuthInvalidError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { PreparedConnection } from "../connection/model.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import {
  RemoteEnvironmentAuthUndeclaredStatusError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/unstable/reactivity";

export class ScheduledRunLoader extends Context.Service<
  ScheduledRunLoader,
  {
    readonly get: <A>(
      prepared: PreparedConnection,
      path: string,
      schema: Schema.ConstraintDecoder<A>,
    ) => Effect.Effect<A, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/scheduled/ScheduledRunLoader") {}

class ScheduledRunConnectionNotReadyError extends Data.TaggedError(
  "ScheduledRunConnectionNotReadyError",
)<{
  readonly message: string;
}> {}

const decodeAuthInvalid = Schema.decodeUnknownOption(EnvironmentAuthInvalidError);

export const scheduledRunLoaderLayer = Layer.effect(
  ScheduledRunLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return ScheduledRunLoader.of({
      get: <A>(prepared: PreparedConnection, path: string, schema: Schema.ConstraintDecoder<A>) =>
        executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization,
          group: "auth",
          method: "GET",
          timeoutMs: 10_000,
          url: (base) => new URL(path, base).toString(),
          request: ({ headers, url }) =>
            Effect.gen(function* () {
              const response = yield* httpClient.execute(
                HttpClientRequest.get(url, { headers: { ...headers } }),
              );
              const body = yield* response.json;
              if (response.status === 401) {
                const invalid = decodeAuthInvalid(body);
                if (Option.isSome(invalid)) return yield* invalid.value;
              }
              if (response.status < 200 || response.status >= 300) {
                return yield* new RemoteEnvironmentAuthUndeclaredStatusError(url, response.status);
              }
              return yield* Schema.decodeUnknownEffect(schema)(body);
            }),
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
    });
  }),
);

/** Queries run only while their screen is mounted; no background refresh loop. */
export function createScheduledRunAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ScheduledRunLoader | R, E>,
) {
  const query = <Input, A>(
    label: string,
    path: (input: Input) => string,
    schema: Schema.ConstraintDecoder<A>,
  ) =>
    createEnvironmentQueryAtomFamily(runtime, {
      label,
      staleTimeMs: 30_000,
      execute: (input: Input) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const loader = yield* ScheduledRunLoader;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared))
            return yield* new ScheduledRunConnectionNotReadyError({
              message: "The environment is not connected.",
            });
          return yield* loader.get(prepared.value, path(input), schema);
        }),
    });
  return {
    routines: query(
      "scheduled:routines",
      (input: { cursor?: string }) =>
        `/api/codex/scheduled${input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : ""}`,
      CodexScheduledRoutineListResponse,
    ),
    runs: query(
      "scheduled:runs",
      (input: { name: string; cursor?: string }) => {
        const params = new URLSearchParams({ name: input.name });
        if (input.cursor) params.set("cursor", input.cursor);
        return `/api/codex/scheduled/runs?${params}`;
      },
      CodexScheduledRunListResponse,
    ),
    transcript: query(
      "scheduled:transcript",
      (input: { id: string; beforeCursor?: string }) =>
        `/api/codex/scheduled/runs/${encodeURIComponent(input.id)}${input.beforeCursor ? `?beforeCursor=${encodeURIComponent(input.beforeCursor)}` : ""}`,
      CodexDesktopThreadHistoryResponse,
    ),
  };
}
