import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Data from "effect/Data";
import { CodexAppServerSpawnError } from "effect-codex-app-server/errors";
import {
  isTransientConnectionFailure,
  retryConnection,
  retryScopedConnection,
} from "./connectionRetry.ts";
class ConnectionError extends Data.TaggedError("ConnectionError")<{ message: string }> {}

it.live(
  "closes failed connection resources before retrying and retains the successful connection",
  () =>
    Effect.gen(function* () {
      let opened = 0;
      let closed = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* retryScopedConnection(
            Effect.gen(function* () {
              assert.equal(closed, opened);
              opened++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closed++;
                }),
              );
              if (opened < 3)
                return yield* Effect.fail(new ConnectionError({ message: "ECONNREFUSED" }));
              return "connected";
            }),
          );
          assert.equal(opened, 3);
          assert.equal(closed, 2);
        }),
      );
      assert.equal(closed, 3);
    }),
);

it("recognizes nested daemon connection failures without retrying permission failures", () => {
  const makeError = (message: string) =>
    new CodexAppServerSpawnError({
      command: "connect to Codex desktop daemon at /tmp/app-server-control.sock",
      cause: new Error(message),
    });
  for (const message of [
    "ENOENT",
    "ECONNREFUSED",
    "Timed out waiting for handshake",
    "socket closed",
  ]) {
    assert.isTrue(isTransientConnectionFailure(makeError(message)));
  }
  assert.isFalse(isTransientConnectionFailure(makeError("EACCES")));
});

it("does not retry account, schema, missing executable or permission failures", () => {
  for (const message of [
    "unauthenticated",
    "Invalid payload during decode-payload",
    "ENOENT",
    "EACCES",
  ]) {
    assert.isFalse(isTransientConnectionFailure(new Error(message)));
  }
});

it.live("recovers a connection before reporting an error", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const result = yield* retryConnection(
      Effect.suspend(() => {
        attempts++;
        return attempts < 3
          ? Effect.fail(new ConnectionError({ message: "ECONNREFUSED" }))
          : Effect.succeed("connected");
      }),
    );
    assert.equal(result, "connected");
    assert.equal(attempts, 3);
  }),
);

it.live("stops after three attempts", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const result = yield* retryConnection(
      Effect.suspend(() => {
        attempts++;
        return Effect.fail(new ConnectionError({ message: "ECONNRESET" }));
      }),
    ).pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.equal(attempts, 3);
  }),
);

it.effect("reports sign-in failures without repeating the request", () =>
  Effect.gen(function* () {
    let attempts = 0;
    yield* retryConnection(
      Effect.suspend(() => {
        attempts++;
        return Effect.fail(new ConnectionError({ message: "unauthenticated" }));
      }),
    ).pipe(Effect.result);
    assert.equal(attempts, 1);
  }),
);
