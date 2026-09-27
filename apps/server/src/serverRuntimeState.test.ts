import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerRuntimeState from "./serverRuntimeState.ts";

const isServerRuntimeStateError = Schema.is(ServerRuntimeState.ServerRuntimeStateError);
const encodeRuntimeState = Schema.encodeUnknownEffect(
  Schema.fromJsonString(ServerRuntimeState.PersistedServerRuntimeState),
);

describe("serverRuntimeState", () => {
  it.effect("grants exactly one concurrent ownership acquisition and releases on scope exit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-lock-test-" });
      const statePath = path.join(root, "userdata", "server-runtime.json");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const attempts = yield* Effect.all(
            [
              Effect.result(ServerRuntimeState.acquireServerRuntimeOwnership(statePath)),
              Effect.result(ServerRuntimeState.acquireServerRuntimeOwnership(statePath)),
            ],
            { concurrency: "unbounded" },
          );
          const winners = attempts.filter((result) => result._tag === "Success");
          const losers = attempts.filter((result) => result._tag === "Failure");
          assert.lengthOf(winners, 1);
          assert.lengthOf(losers, 1);
          assert.equal(losers[0]?.failure._tag, "ServerRuntimeOwnershipError");
          yield* Effect.acquireRelease(
            Effect.succeed(winners[0]!.success),
            ServerRuntimeState.releaseServerRuntimeOwnership,
          );
        }),
      );

      yield* Effect.scoped(
        Effect.acquireRelease(
          ServerRuntimeState.acquireServerRuntimeOwnership(statePath),
          ServerRuntimeState.releaseServerRuntimeOwnership,
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reclaims the ownership lock after an owner process exits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-lock-test-" });
      const statePath = path.join(root, "userdata", "server-runtime.json");
      const stalePid = Number.MAX_SAFE_INTEGER;
      assert.isFalse(ServerRuntimeState.isProcessAlive(stalePid));
      const staleState = {
        version: 1,
        pid: stalePid,
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        startedAt: "2026-06-20T00:00:00.000Z",
      } satisfies ServerRuntimeState.PersistedServerRuntimeState;

      yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
      const encoded = yield* encodeRuntimeState(staleState);
      yield* fs.writeFileString(statePath, encoded);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            ServerRuntimeState.acquireServerRuntimeOwnership(statePath),
            ServerRuntimeState.releaseServerRuntimeOwnership,
          );
          yield* ServerRuntimeState.ensureServerRuntimeStateAvailable(statePath);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports the recorded PID and port when another server holds the lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-lock-test-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = {
        version: 1,
        pid: process.pid,
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        startedAt: "2026-06-20T00:00:00.000Z",
      } satisfies ServerRuntimeState.PersistedServerRuntimeState;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            ServerRuntimeState.acquireServerRuntimeOwnership(statePath),
            ServerRuntimeState.releaseServerRuntimeOwnership,
          );
          yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });
          const error = yield* ServerRuntimeState.acquireServerRuntimeOwnership(statePath).pipe(
            Effect.flip,
          );
          assert.equal(error._tag, "ServerRuntimeAlreadyRunningError");
          assert.equal(
            error.message,
            `Cannot start another T3 server for this data directory: PID ${process.pid} is already running on port 4971.`,
          );
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed when the ownership lock is corrupt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-lock-test-" });
      const statePath = path.join(root, "server-runtime.json");
      yield* fs.writeFileString(path.join(root, "server-ownership.sqlite"), "not sqlite");
      const error = yield* ServerRuntimeState.acquireServerRuntimeOwnership(statePath).pipe(
        Effect.flip,
      );
      assert.equal(error._tag, "ServerRuntimeOwnershipError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("persists and reads the runtime state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "runtime", "server.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        host: "127.0.0.1",
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        devUrl: "http://localhost:5733/",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.deepEqual(Option.getOrThrow(restored), state);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records the dev web URL when the server fronts a dev server", () =>
    Effect.gen(function* () {
      const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: new URL("http://localhost:5733") },
        port: 13_773,
      });

      assert.equal(state.devUrl, "http://localhost:5733/");
      assert.equal(state.origin, "http://127.0.0.1:13773");

      const withoutDev = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });
      assert.isFalse("devUrl" in withoutDev);
    }),
  );

  it.effect("treats a missing runtime state file as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        path.join(root, "missing.json"),
      );

      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed on malformed or empty runtime state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.writeFileString(statePath, "{not json");

      for (const contents of ["{not json", "  \n"]) {
        yield* fileSystem.writeFileString(statePath, contents);
        const error = yield* ServerRuntimeState.ensureServerRuntimeStateAvailable(statePath).pipe(
          Effect.flip,
        );
        assert.isTrue(isServerRuntimeStateError(error));
        if (isServerRuntimeStateError(error)) {
          assert.equal(error.operation, "decode");
          assert.equal(error.statePath, statePath);
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed on runtime state read failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.makeDirectory(statePath);

      const error = yield* ServerRuntimeState.ensureServerRuntimeStateAvailable(statePath).pipe(
        Effect.flip,
      );
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "read");
        assert.equal(error.statePath, statePath);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves runtime state persistence failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const blockedDirectory = path.join(root, "not-a-directory");
      const statePath = path.join(blockedDirectory, "server.json");
      yield* fileSystem.writeFileString(blockedDirectory, "blocked");

      const error = yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: {
          version: 1,
          pid: 123,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }).pipe(Effect.flip);

      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "persist");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to persist server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not overwrite state owned by another live server", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      const current = {
        version: 1,
        pid: process.pid,
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        startedAt: "2026-06-20T00:00:00.000Z",
      } satisfies ServerRuntimeState.PersistedServerRuntimeState;
      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state: current });

      const error = yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: { ...current, pid: process.pid + 1, port: 4_972 },
      }).pipe(Effect.flip);

      assert.equal(error._tag, "ServerRuntimeAlreadyRunningError");
      assert.equal(
        error.message,
        `Cannot start another T3 server for this data directory: PID ${process.pid} is already running on port 4971.`,
      );
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.deepEqual(Option.getOrThrow(restored), current);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows replacing state whose process is dead", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      const stalePid = Number.MAX_SAFE_INTEGER;
      assert.isFalse(ServerRuntimeState.isProcessAlive(stalePid));
      const replacement = {
        version: 1,
        pid: process.pid,
        port: 4_972,
        origin: "http://127.0.0.1:4972",
        startedAt: "2026-06-21T00:00:00.000Z",
      } satisfies ServerRuntimeState.PersistedServerRuntimeState;

      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: {
          ...replacement,
          pid: stalePid,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
        },
      });
      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state: replacement });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.deepEqual(Option.getOrThrow(restored), replacement);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("clears runtime state only when pid and startedAt still match", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      const current = {
        version: 1,
        pid: process.pid,
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        startedAt: "2026-06-20T00:00:00.000Z",
      } satisfies ServerRuntimeState.PersistedServerRuntimeState;
      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state: current });

      yield* ServerRuntimeState.clearPersistedServerRuntimeState({
        path: statePath,
        pid: current.pid,
        startedAt: "2026-06-21T00:00:00.000Z",
      });
      let restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.deepEqual(Option.getOrThrow(restored), current);

      yield* ServerRuntimeState.clearPersistedServerRuntimeState({
        path: statePath,
        pid: current.pid + 1,
        startedAt: current.startedAt,
      });
      restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.deepEqual(Option.getOrThrow(restored), current);

      yield* ServerRuntimeState.clearPersistedServerRuntimeState({
        path: statePath,
        pid: current.pid,
        startedAt: current.startedAt,
      });
      restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
