// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { assert, describe } from "vite-plus/test";
import fixture from "./testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./Layers/CodexSessionRuntime.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      operation: Schema.String,
      threadId: Schema.optional(Schema.String),
      runId: Schema.optional(Schema.String),
      outcome: Schema.optional(Schema.String),
    }),
  ),
);

describe("T3 owns the primary turn browser lifecycle", () => {
  for (const outcome of ["completed", "failed", "cancelled"]) {
    it.effect(outcome, () =>
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-run-owner-wire-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const journal = NodePath.join(root, "events.jsonl");
        const modulePath = NodePath.join(root, "binding.mjs");
        NodeFS.writeFileSync(
          modulePath,
          [
            'import {appendFileSync} from "node:fs";',
            "const record = row => appendFileSync(" +
              encode(journal) +
              ', JSON.stringify(row)+"\\\\n");',
            'export async function createT3RunBinding({threadId}) { record({operation:"configure",threadId}); return {appServerArgs: [],',
            'async begin(runId) {record({operation:"begin",runId});},',
            'async end(runId,outcome) {record({operation:"end",runId,outcome});},',
            'close() {record({operation:"close"});} };}',
          ]
            .join("\n")
            .replace('"\\\\n"', '"\\n"'),
        );
        const script = NodePath.join(root, "peer.json");
        const turn = {
          ...fixture.responses.turnStart.turn,
          id: "owned-turn",
          status: "failed",
          error: { message: "synthetic failure", codexErrorInfo: null, additionalDetails: null },
        };
        NodeFS.writeFileSync(
          script,
          encode({
            rootThreadId: fixture.rootThreadId,
            turnIds: ["owned-turn"],
            holdTurnOpen: outcome !== "completed",
            notifications: [
              { method: "turn/completed", params: { threadId: "foreign-thread", turn } },
              ...(outcome === "failed"
                ? [{ method: "turn/completed", params: { threadId: fixture.rootThreadId, turn } }]
                : []),
            ],
          }),
        );
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("browser-binding-fixture"),
          binaryPath: NodePath.join(import.meta.dirname, "testFixtures/codexCollabMockPeer.sh"),
          cwd: root,
          runtimeMode: "approval-required",
          environment: {
            ...process.env,
            T3_CODEX_COLLAB_SCRIPT: script,
            T3_WORK_BROWSER_BINDING: modulePath,
          },
        });
        yield* runtime.start();
        const delivered = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.method === (outcome === "cancelled" ? "turn/started" : "turn/completed"),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.sendTurn({ input: "Synthetic protocol fixture, no model" });
        yield* Fiber.join(delivered);
        if (outcome === "cancelled") yield* runtime.interruptTurn();
        const events = NodeFS.readFileSync(journal, "utf8")
          .trim()
          .split("\n")
          .map((line) => decodeEvent(line));
        assert.deepEqual(
          events.filter((event) => event.operation === "configure"),
          [{ operation: "configure", threadId: "browser-binding-fixture" }],
        );
        assert.deepEqual(
          events.filter((event) => event.operation === "begin"),
          [{ operation: "begin", runId: "owned-turn" }],
        );
        assert.isTrue(
          events.some(
            (event) =>
              event.operation === "end" &&
              event.runId === "owned-turn" &&
              event.outcome === outcome,
          ),
        );
        assert.isFalse(
          events.some((event) => event.runId !== undefined && event.runId !== "owned-turn"),
        );
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});
