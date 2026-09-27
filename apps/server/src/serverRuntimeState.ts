import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import type * as ServerConfig from "./config.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  // Present when the server fronts a dev web server (VITE_DEV_SERVER_URL).
  // Dev is single-origin: browsers must pair through this URL, not `origin`.
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

export class ServerRuntimeStateError extends Schema.TaggedErrorClass<ServerRuntimeStateError>()(
  "ServerRuntimeStateError",
  {
    operation: Schema.Literals(["persist", "read", "decode", "clear"]),
    statePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} server runtime state at ${this.statePath}.`;
  }
}

export class ServerRuntimeAlreadyRunningError extends Schema.TaggedErrorClass<ServerRuntimeAlreadyRunningError>()(
  "ServerRuntimeAlreadyRunningError",
  {
    statePath: Schema.String,
    pid: Schema.Int,
    port: Schema.Int,
  },
) {
  override get message(): string {
    return `Cannot start another T3 server for this data directory: PID ${this.pid} is already running on port ${this.port}.`;
  }
}

export class ServerRuntimeOwnershipError extends Schema.TaggedErrorClass<ServerRuntimeOwnershipError>()(
  "ServerRuntimeOwnershipError",
  {
    lockPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Cannot start T3 server: another server owns this data directory, or the ownership lock at ${this.lockPath} cannot be written. Check the existing server and the lock file permissions.`;
  }
}

/** A SQLite write transaction is an OS-reclaimed, cross-process lock. */
export const acquireServerRuntimeOwnership = (statePath: string) => {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockPath = path.join(path.dirname(statePath), "server-ownership.sqlite");
    yield* fs
      .makeDirectory(path.dirname(lockPath), { recursive: true })
      .pipe(Effect.mapError((cause) => new ServerRuntimeOwnershipError({ lockPath, cause })));
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    return yield* Effect.try({
      try: () => {
        const database = new NodeSqlite.DatabaseSync(lockPath, { timeout: 0 });
        try {
          database.exec("BEGIN IMMEDIATE");
          database.exec(
            "CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL, started_at TEXT NOT NULL, token TEXT NOT NULL)",
          );
          database.exec("DELETE FROM owner");
          database
            .prepare("INSERT INTO owner VALUES (?, ?, ?)")
            .run(process.pid, startedAt, NodeCrypto.randomUUID());
          return {
            release: () => {
              try {
                database.exec("ROLLBACK");
              } finally {
                database.close();
              }
            },
          };
        } catch (error) {
          database.close();
          throw error;
        }
      },
      catch: (cause) => new ServerRuntimeOwnershipError({ lockPath, cause }),
    }).pipe(
      Effect.catchTag("ServerRuntimeOwnershipError", (error) => {
        const cause = error.cause;
        if (
          typeof cause !== "object" ||
          cause === null ||
          !("errcode" in cause) ||
          cause.errcode !== 5
        ) {
          return Effect.fail(error);
        }
        return Effect.gen(function* () {
          const state = yield* readPersistedServerRuntimeState(statePath);
          if (Option.isSome(state) && isProcessAlive(state.value.pid)) {
            return yield* new ServerRuntimeAlreadyRunningError({
              statePath,
              pid: state.value.pid,
              port: state.value.port,
            });
          }
          return yield* error;
        });
      }),
    );
  });
};

export const releaseServerRuntimeOwnership = (ownership: { readonly release: () => void }) =>
  Effect.sync(() => ownership.release());

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);
const encodePersistedServerRuntimeState = Schema.encodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const runtimeOriginForConfig = (
  config: Pick<ServerConfig.ServerConfig["Service"], "host">,
  port: number,
): PersistedServerRuntimeState["origin"] => {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${port}`;
};

export const makePersistedServerRuntimeState = (input: {
  readonly config: Pick<ServerConfig.ServerConfig["Service"], "host" | "devUrl">;
  readonly port: number;
}): Effect.Effect<PersistedServerRuntimeState> =>
  Effect.map(DateTime.now, (now) => ({
    version: 1,
    pid: process.pid,
    ...(input.config.host ? { host: input.config.host } : {}),
    port: input.port,
    origin: runtimeOriginForConfig(input.config, input.port),
    ...(input.config.devUrl ? { devUrl: input.config.devUrl.toString() } : {}),
    startedAt: DateTime.formatIso(now),
  }));

export const persistServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  Effect.gen(function* () {
    yield* ensureServerRuntimeStateAvailable(input.path, input.state.pid);
    const encoded = yield* encodePersistedServerRuntimeState(input.state).pipe(
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "persist",
            statePath: input.path,
            cause,
          }),
      ),
    );
    yield* writeFileStringAtomically({
      filePath: input.path,
      contents: `${encoded}\n`,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "persist",
            statePath: input.path,
            cause,
          }),
      ),
    );
  });

export const clearPersistedServerRuntimeState = (input: {
  readonly path: string;
  readonly pid: number;
  readonly startedAt: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const current = yield* readPersistedServerRuntimeState(input.path);
    if (
      Option.isNone(current) ||
      current.value.pid !== input.pid ||
      current.value.startedAt !== input.startedAt ||
      (current.value.pid !== process.pid && isProcessAlive(current.value.pid))
    ) {
      return;
    }

    yield* fs.remove(input.path, { force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "clear",
            statePath: input.path,
            cause,
          }),
      ),
      Effect.catchTags({
        ServerRuntimeStateError: (error) =>
          Effect.logWarning(error.message).pipe(
            Effect.annotateLogs({
              operation: error.operation,
              statePath: error.statePath,
              cause: error,
            }),
          ),
      }),
    );
  });

/**
 * Report whether the pid recorded in a persisted runtime state is still
 * running. Signal 0 delivers nothing; it only reports whether the pid exists.
 * EPERM means it exists but belongs to another user, which still counts as
 * alive.
 */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export const ensureServerRuntimeStateAvailable = (path: string, currentPid = process.pid) =>
  readPersistedServerRuntimeState(path).pipe(
    Effect.flatMap((existing) => {
      if (
        Option.isNone(existing) ||
        existing.value.pid === currentPid ||
        !isProcessAlive(existing.value.pid)
      ) {
        return Effect.void;
      }

      return Effect.fail(
        new ServerRuntimeAlreadyRunningError({
          statePath: path,
          pid: existing.value.pid,
          port: existing.value.port,
        }),
      );
    }),
  );

export const readPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new ServerRuntimeStateError({
                  operation: "read",
                  statePath: path,
                  cause,
                }),
              ),
        onSuccess: (contents) => Effect.succeed(Option.some(contents)),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<PersistedServerRuntimeState>();
    }

    const trimmed = raw.value.trim();
    return yield* decodePersistedServerRuntimeState(trimmed).pipe(
      Effect.map(Option.some),
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "decode",
            statePath: path,
            cause,
          }),
      ),
    );
  });
