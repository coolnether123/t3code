import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";

export function isTransientConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const messages: string[] = [];
  const seen = new Set<Error>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  const message = messages.join("\n");
  if (/unauth|sign.?in|credential|forbidden|invalid payload|decode-payload|EACCES/i.test(message)) {
    return false;
  }
  if (/ENOENT/i.test(message)) return /app-server-control\.sock/i.test(message);
  return /ECONNREFUSED|ECONNRESET|EPIPE|timed out|timeout|socket.*closed|closed.*handshake|connection.*closed/i.test(
    message,
  );
}

// Only apply before sending a turn. Retrying an unacknowledged turn can duplicate work.
export const retryConnection = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential("500 millis"),
      while: isTransientConnectionFailure,
    }),
  );

/** Failed connection attempts release their processes before the next attempt starts. */
export const retryScopedConnection = Effect.fn("retryScopedConnection")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const scope = yield* Scope.fork(yield* Scope.Scope);
  return yield* effect.pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
  );
}, retryConnection);
