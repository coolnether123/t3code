import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import {
  uncertainUpdateRuns,
  updateCheckpointDecision,
  holdUpdateCheckpoint,
  readUpdateCheckpoint,
} from "./UpdateCheckpoint.ts";

it("allows only checkpoint-authorized sources and keeps uncertain or crash-window work held", () => {
  const checkpoint = {
    version: 1,
    authorizedRunIds: ["safe", "uncertain"],
    heldRunIds: ["uncertain"],
  };
  assert.equal(updateCheckpointDecision(checkpoint, "safe"), "continue");
  assert.equal(updateCheckpointDecision(checkpoint, "uncertain"), "held");
  assert.equal(updateCheckpointDecision(checkpoint, "unknown-after-checkpoint"), "held");
  assert.equal(updateCheckpointDecision(null, "safe"), "held");
});

it.effect("persists a late uncertainty hold before a prepared continuation can dispatch", () =>
  Effect.gen(function* () {
    let text = '{"version":1,"active":true,"authorizedRunIds":["source"],"heldRunIds":[]}';
    let temporary = text;
    const layer = Layer.mergeAll(
      Layer.succeed(ServerConfig.ServerConfig, { baseDir: "/synthetic" } as never),
      FileSystem.layerNoop({
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.sync(() => text),
        writeFileString: (_, value) =>
          Effect.sync(() => {
            temporary = value;
          }),
        chmod: () => Effect.void,
        rename: () =>
          Effect.sync(() => {
            text = temporary;
          }),
      }),
    );
    assert.equal(yield* readUpdateCheckpoint("source").pipe(Effect.provide(layer)), "continue");
    yield* holdUpdateCheckpoint(["source"]).pipe(Effect.provide(layer));
    assert.equal(yield* readUpdateCheckpoint("source").pipe(Effect.provide(layer)), "held");
    yield* holdUpdateCheckpoint(["source"]).pipe(Effect.provide(layer));
    assert.deepEqual(JSON.parse(text).heldRunIds, ["source"]);
    assert.match(JSON.parse(text).recoveryHoldReason, /do not replay/);
  }),
);

it("reclassifies thinking checkpoints when a tool or approval started before the crash", () => {
  const projection = {
    runs: [{ id: "safe-at-capture" }],
    turnItems: [],
    runtimeRequests: [],
    subagents: [],
  };
  assert.deepEqual(uncertainUpdateRuns(projection as never), []);
  assert.deepEqual(
    uncertainUpdateRuns({
      ...projection,
      turnItems: [{ runId: "safe-at-capture", type: "dynamic_tool", status: "running" }],
    } as never),
    ["safe-at-capture"],
  );
  assert.deepEqual(
    uncertainUpdateRuns({
      ...projection,
      turnItems: [{ runId: "safe-at-capture", type: "command_execution", status: "interrupted" }],
    } as never),
    ["safe-at-capture"],
  );
  assert.deepEqual(
    uncertainUpdateRuns({ ...projection, runtimeRequests: [{ status: "pending" }] } as never),
    ["safe-at-capture"],
  );
});
