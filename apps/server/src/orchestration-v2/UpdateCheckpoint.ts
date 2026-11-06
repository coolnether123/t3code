import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCheckpoint = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const makeUpdateCheckpointAccess = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const layer =
    Option.isSome(config) && Option.isSome(fs)
      ? Layer.merge(
          Layer.succeed(ServerConfig.ServerConfig, config.value),
          Layer.succeed(FileSystem.FileSystem, fs.value),
        )
      : Layer.empty;
  return {
    read: (runId: string) => readUpdateCheckpoint(runId).pipe(Effect.provide(layer)),
    hold: (runIds: readonly string[]) => holdUpdateCheckpoint(runIds).pipe(Effect.provide(layer)),
    threads: readUpdateCheckpointThreads().pipe(Effect.provide(layer)),
  };
});

const readUpdateCheckpointThreads = Effect.fn("UpdateCheckpoint.threads")(function* () {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  if (Option.isNone(config) || Option.isNone(fs)) return [];
  const path = `${config.value.baseDir}/runtime/update-checkpoint.json`;
  return yield* fs.value.readFileString(path).pipe(
    Effect.flatMap(decodeCheckpoint),
    Effect.map((checkpoint) =>
      checkpoint.active === true && Array.isArray(checkpoint.sourceThreadIds)
        ? checkpoint.sourceThreadIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [],
    ),
    Effect.orElseSucceed(() => []),
  );
});

export function uncertainUpdateRuns(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "runs" | "turnItems" | "runtimeRequests" | "subagents"
  >,
): string[] {
  const open = new Set(["pending", "running", "waiting", "starting"]);
  const uncertain = new Set([...open, "interrupted", "cancelled"]);
  const threadHeld =
    projection.runtimeRequests.some((request) => request.status === "pending") ||
    projection.subagents.some((child) => open.has(child.status) && child.origin !== "app_owned");
  return projection.runs
    .filter(
      (run) =>
        threadHeld ||
        (run.restartCancelledBackgroundWork ?? []).some((work) => work.kind !== "subagent") ||
        projection.turnItems.some(
          (item) =>
            item.runId === run.id &&
            uncertain.has(item.status) &&
            ["command_execution", "dynamic_tool", "file_change", "image_generation"].includes(
              item.type,
            ),
        ),
    )
    .map((run) => run.id);
}

export function updateCheckpointDecision(
  value: unknown,
  runId: string,
): "continue" | "held" | undefined {
  if (typeof value !== "object" || value === null) return "held";
  const checkpoint = value as Record<string, unknown>;
  if (
    checkpoint.version !== 1 ||
    !Array.isArray(checkpoint.heldRunIds) ||
    !Array.isArray(checkpoint.authorizedRunIds)
  )
    return "held";
  return checkpoint.heldRunIds.includes(runId)
    ? "held"
    : checkpoint.authorizedRunIds.includes(runId)
      ? "continue"
      : checkpoint.active === false ||
          (Array.isArray(checkpoint.knownRunIds) && checkpoint.knownRunIds.includes(runId))
        ? undefined
        : "held";
}

export const readUpdateCheckpoint = Effect.fn("UpdateCheckpoint.read")(function* (runId: string) {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  if (Option.isNone(config) || Option.isNone(fs)) return undefined;
  const path = `${config.value.baseDir}/runtime/update-checkpoint.json`;
  if (!(yield* fs.value.exists(path).pipe(Effect.orElseSucceed(() => true)))) return undefined;
  return yield* fs.value.readFileString(path).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) => updateCheckpointDecision(value, runId)),
    Effect.orElseSucceed(() => "held" as const),
  );
});

export const holdUpdateCheckpoint = Effect.fn("UpdateCheckpoint.hold")(function* (
  runIds: readonly string[],
) {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  if (Option.isNone(config) || Option.isNone(fs) || runIds.length === 0) return;
  const path = `${config.value.baseDir}/runtime/update-checkpoint.json`;
  if (!(yield* fs.value.exists(path))) return;
  const checkpoint: Record<string, unknown> = {
    ...(yield* decodeCheckpoint(yield* fs.value.readFileString(path))),
  };
  if (checkpoint.active === false) return;
  checkpoint.heldRunIds = [
    ...new Set([...(Array.isArray(checkpoint.heldRunIds) ? checkpoint.heldRunIds : []), ...runIds]),
  ];
  checkpoint.recoveryHoldReason =
    "Tool result or approval changed after the update checkpoint. Reconcile before continuing; do not replay.";
  const reasons =
    typeof checkpoint.heldReasons === "object" && checkpoint.heldReasons !== null
      ? checkpoint.heldReasons
      : {};
  checkpoint.heldReasons = {
    ...reasons,
    ...Object.fromEntries(
      runIds.map((id) => [id, ["changed-after-checkpoint", "reconcile-before-replay"]]),
    ),
  };
  const temporary = `${path}.recovery`;
  const text = yield* encodeJson(checkpoint);
  yield* fs.value.writeFileString(temporary, text);
  yield* fs.value.chmod(temporary, 0o600);
  yield* fs.value.rename(temporary, path);
}, Effect.orDie);
