import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

// Opening resumes the thread's whole history; long, reused chats can take minutes.
// Turn starts are isolated per thread, so a slow open only delays its own chat.
export const CODEX_SESSION_OPEN_TIMEOUT = "20 minutes";
export const CODEX_TURN_ACCEPTANCE_TIMEOUT = "90 seconds";

const isRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const isTimeoutData = Schema.is(Schema.Struct({ t3RequestTimeout: Schema.Literal(true) }));
export const isCodexRequestTimeout = (error: unknown): boolean =>
  isRequestError(error) && isTimeoutData(error.data);

/** Bounds acceptance of a request, not the duration of an agent's turn. */
export const withCodexRequestDeadline = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  method: string,
  phase: "opening this chat" | "starting this turn",
) => {
  const timeout =
    phase === "opening this chat" ? CODEX_SESSION_OPEN_TIMEOUT : CODEX_TURN_ACCEPTANCE_TIMEOUT;
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new CodexErrors.CodexAppServerRequestError({
            code: -32603,
            errorMessage: `Codex didn't answer while ${phase}; try again. No response to ${method} within ${timeout}.`,
            method,
            operation: "receive-response",
            data: { t3RequestTimeout: true },
          }),
        ),
    }),
  );
};
