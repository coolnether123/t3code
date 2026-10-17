import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

const isRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const isRuntimeStatus = Schema.is(Schema.Struct({ type: Schema.String }));
const decodeSteeringThread = Schema.decodeUnknownEffect(
  Schema.Struct({
    thread: Schema.Struct({
      id: Schema.String,
      turns: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
      status: Schema.optionalKey(Schema.Unknown),
    }),
  }),
);
const decodeThreadMetadata = Schema.decodeUnknownEffect(
  Schema.Struct({
    thread: Schema.Struct({
      id: Schema.String,
      status: Schema.Struct({ type: Schema.Literals(["idle", "active"]) }),
    }),
  }),
);
type ObservedRootTurn = { readonly threadId: string; readonly turnId: string };

function isUnsupportedTurnHistory(error: CodexErrors.CodexAppServerError): boolean {
  return (
    isRequestError(error) &&
    error.operation === "receive-response" &&
    error.method === "thread/read" &&
    error.code === -32601 &&
    error.errorMessage === "list_turns is not supported yet"
  );
}

export function withCodexDeliveryDeadline<A>(
  method: "thread/read" | "turn/steer" | "turn/start",
  request: Effect.Effect<A, CodexErrors.CodexAppServerError>,
) {
  return request.pipe(
    Effect.timeoutOption(method === "thread/read" ? "90 seconds" : "10 seconds"),
    Effect.flatMap((result) =>
      result._tag === "Some"
        ? Effect.succeed(result.value)
        : CodexErrors.CodexAppServerRequestError.internalError(
            `Steering ${method} timed out. Delivery is not confirmed; do not retry automatically.`,
            undefined,
            { method },
          ),
    ),
  );
}

/** Only a provider's explicit pre-delivery turn mismatch permits another send. */
function isRejectedStaleTurn(error: CodexErrors.CodexAppServerError): boolean {
  return (
    isRequestError(error) &&
    error.operation === "receive-response" &&
    error.method === "turn/steer" &&
    error.code === -32600 &&
    /^(?:active turn mismatch|expected turn id .+ (?:does not match|but found) .+)$/i.test(
      error.errorMessage,
    )
  );
}

/** Null means verified idle, never a failed or ambiguous read. */
export const readCodexActiveTurn = Effect.fn("readCodexActiveTurn")(function* (input: {
  readonly providerThreadId: string;
  readonly readThread: Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
  readonly readThreadMetadata?: Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
  readonly readObservedRootTurn?: Effect.Effect<ObservedRootTurn | undefined>;
}) {
  // Native Codex can add item variants before our generated protocol catches
  // up. Steering needs only parent identity and turn status, never item data.
  const readThread = input.readThread.pipe(
    Effect.catch((error) => {
      if (!isUnsupportedTurnHistory(error) || input.readThreadMetadata === undefined) {
        return Effect.fail(error);
      }
      // Some desktop daemons cannot load turn history, even for new threads.
      // Summary turns:[] is not history. Idle status proves no active turn.
      // Active status needs a root-native observation, never a T3 projection;
      // turn/steer's expectedTurnId still lets the provider reject stale IDs.
      return input.readThreadMetadata.pipe(
        Effect.flatMap(decodeThreadMetadata),
        Effect.mapError((error) =>
          Schema.isSchemaError(error)
            ? CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
                "decode-response-payload",
                error,
                { method: "thread/read" },
              )
            : error,
        ),
        Effect.flatMap((metadata) =>
          Effect.gen(function* () {
            if (metadata.thread.status.type === "idle") {
              return { thread: { id: metadata.thread.id, turns: [] } };
            }
            const observed = input.readObservedRootTurn
              ? yield* input.readObservedRootTurn
              : undefined;
            if (
              metadata.thread.id !== input.providerThreadId ||
              observed?.threadId !== input.providerThreadId ||
              !observed.turnId
            ) {
              return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
                "Message was not sent: active provider metadata has no bound native root turn observation.",
              );
            }
            return {
              thread: {
                id: metadata.thread.id,
                turns: [{ id: observed.turnId, status: "inProgress" }],
              },
            };
          }),
        ),
      );
    }),
  );
  const snapshot = yield* withCodexDeliveryDeadline("thread/read", readThread).pipe(
    Effect.flatMap((response) =>
      decodeSteeringThread(response).pipe(
        Effect.mapError((error) =>
          CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
            "decode-response-payload",
            error,
            { method: "thread/read" },
          ),
        ),
      ),
    ),
  );
  const active = snapshot.thread.turns.filter((turn) => turn.status === "inProgress");
  const [turn] = active;
  const runtimeStatus = isRuntimeStatus(snapshot.thread.status)
    ? snapshot.thread.status.type
    : undefined;
  if (
    snapshot.thread.id !== input.providerThreadId ||
    active.length > 1 ||
    (runtimeStatus === "active" && active.length !== 1) ||
    (runtimeStatus === "idle" && active.length !== 0) ||
    snapshot.thread.turns.some(
      (entry) => !["inProgress", "completed", "interrupted", "failed"].includes(entry.status),
    )
  ) {
    return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
      "Message was not sent: the bound provider thread state is ambiguous or has the wrong identity.",
    );
  }
  return turn?.id ?? null;
});

/** Resolve only the bound parent thread; never infer its active turn from T3 projections. */
export const steerCodexActiveTurn = Effect.fn("steerCodexActiveTurn")(function* (input: {
  readonly providerThreadId: string;
  readonly readThread: Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
  readonly readThreadMetadata?: Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
  readonly readObservedRootTurn?: Effect.Effect<ObservedRootTurn | undefined>;
  readonly initialActiveTurnId?: string;
  readonly steerTurn: (
    turnId: string,
  ) => Effect.Effect<{ readonly turnId: string }, CodexErrors.CodexAppServerError>;
}) {
  const readActiveTurn = Effect.gen(function* () {
    const turnId = yield* readCodexActiveTurn(input);
    if (turnId === null) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
        "Steering was not sent: the bound provider thread has no unambiguous active turn.",
      );
    }
    return turnId;
  });

  let activeTurnId = input.initialActiveTurnId ?? (yield* readActiveTurn);
  let response = yield* withCodexDeliveryDeadline("turn/steer", input.steerTurn(activeTurnId)).pipe(
    Effect.result,
  );
  if (response._tag === "Failure" && isRejectedStaleTurn(response.failure)) {
    const refreshedTurnId = yield* readActiveTurn;
    if (refreshedTurnId !== activeTurnId) {
      activeTurnId = refreshedTurnId;
      response = yield* withCodexDeliveryDeadline("turn/steer", input.steerTurn(activeTurnId)).pipe(
        Effect.result,
      );
    }
  }
  if (response._tag === "Failure") return yield* response.failure;
  if (response.success.turnId !== activeTurnId) {
    return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
      "Steering delivery is uncertain: the provider returned a different turn ID. Do not retry automatically.",
    );
  }
  return response.success;
});
