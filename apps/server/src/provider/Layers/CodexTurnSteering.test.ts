import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";

import { readCodexActiveTurn, steerCodexActiveTurn } from "./CodexTurnSteering.ts";

const active = (id: string) => ({ id, status: "inProgress" });
const unsupportedHistory = () =>
  CodexErrors.CodexAppServerRequestError.fromProtocolError(
    { code: -32601, message: "list_turns is not supported yet" },
    "thread/read",
    "history-read",
  );
const staleRejection = () =>
  CodexErrors.CodexAppServerRequestError.fromProtocolError(
    { code: -32600, message: "active turn mismatch" },
    "turn/steer",
    "request-1",
  );

function harness(options?: {
  readonly snapshots?: ReadonlyArray<
    ReadonlyArray<{ readonly id: string; readonly status: string }>
  >;
  readonly failures?: ReadonlyArray<CodexErrors.CodexAppServerError | undefined>;
  readonly readThreadId?: string;
  readonly responseTurnId?: string;
}) {
  const sends: string[] = [];
  let reads = 0;
  const snapshots = options?.snapshots ?? [[active("real-parent-turn")]];
  return {
    sends,
    reads: () => reads,
    run: steerCodexActiveTurn({
      providerThreadId: "parent-thread",
      readThread: Effect.sync(() => ({
        thread: {
          id: options?.readThreadId ?? "parent-thread",
          turns: snapshots[Math.min(reads++, snapshots.length - 1)] ?? [],
        },
      })),
      steerTurn: (turnId) =>
        Effect.gen(function* () {
          const failure = options?.failures?.[sends.length];
          sends.push(turnId);
          if (failure) return yield* failure;
          return { turnId: options?.responseTurnId ?? turnId };
        }),
    }),
  };
}

describe("provider-authoritative Codex steering", () => {
  it.effect(
    "accepts a new or finished daemon thread only after provider metadata verifies idle",
    () =>
      Effect.gen(function* () {
        for (const summaryTurns of [[], undefined]) {
          let metadataReads = 0;
          const result = yield* readCodexActiveTurn({
            providerThreadId: "parent-thread",
            readThread: unsupportedHistory(),
            readObservedRootTurn: Effect.succeed({
              threadId: "parent-thread",
              turnId: "stale-finished-native-root",
            }),
            readThreadMetadata: Effect.sync(() => {
              metadataReads++;
              return {
                thread: {
                  id: "parent-thread",
                  status: { type: "idle" },
                  ...(summaryTurns ? { turns: summaryTurns } : {}),
                },
              };
            }),
          });
          assert.isNull(result);
          assert.equal(metadataReads, 1);
        }
      }),
  );

  for (const thread of [
    { id: "parent-thread", turns: [] },
    { id: "parent-thread", turns: [], status: { type: "active" } },
    { id: "parent-thread", turns: [], status: { type: "notLoaded" } },
    { id: "parent-thread", turns: [], status: { type: "systemError" } },
    { id: "parent-thread", turns: [], status: { type: "futureStatus" } },
    { id: "wrong-thread", turns: [], status: { type: "idle" } },
  ]) {
    it.effect(
      `does not send after unsupported history with ambiguous metadata ${JSON.stringify(thread)}`,
      () =>
        Effect.gen(function* () {
          let sends = 0;
          yield* steerCodexActiveTurn({
            providerThreadId: "parent-thread",
            readThread: unsupportedHistory(),
            readThreadMetadata: Effect.succeed({ thread }),
            steerTurn: (turnId) =>
              Effect.sync(() => {
                sends++;
                return { turnId };
              }),
          }).pipe(Effect.flip);
          assert.equal(sends, 0);
        }),
    );
  }

  for (const error of [
    CodexErrors.CodexAppServerRequestError.internalError("connection lost"),
    CodexErrors.CodexAppServerRequestError.fromProtocolError(
      { code: -32600, message: "list_turns is not supported yet" },
      "thread/read",
      "read",
    ),
    CodexErrors.CodexAppServerRequestError.fromProtocolError(
      { code: -32601, message: "other unsupported method" },
      "thread/read",
      "read",
    ),
  ]) {
    it.effect(
      `does not use idle metadata to mask an unrelated history failure ${error.message}`,
      () =>
        Effect.gen(function* () {
          let metadataReads = 0;
          const result = yield* readCodexActiveTurn({
            providerThreadId: "parent-thread",
            readThread: error,
            readThreadMetadata: Effect.sync(() => {
              metadataReads++;
              return { thread: { id: "parent-thread", status: { type: "idle" } } };
            }),
          }).pipe(Effect.flip);
          assert.equal(result, error);
          assert.equal(metadataReads, 0);
        }),
    );
  }

  it.effect("does not interpret missing full-history turns as an empty thread", () =>
    Effect.gen(function* () {
      let metadataReads = 0;
      yield* readCodexActiveTurn({
        providerThreadId: "parent-thread",
        readThread: Effect.succeed({ thread: { id: "parent-thread", status: { type: "idle" } } }),
        readThreadMetadata: Effect.sync(() => {
          metadataReads++;
          return {};
        }),
      }).pipe(Effect.flip);
      assert.equal(metadataReads, 0);
    }),
  );

  it.effect("steers unsupported active history only with a bound native root observation", () =>
    Effect.gen(function* () {
      const sends: string[] = [];
      const result = yield* steerCodexActiveTurn({
        providerThreadId: "parent-thread",
        readThread: unsupportedHistory(),
        readThreadMetadata: Effect.succeed({
          thread: { id: "parent-thread", status: { type: "active" }, turns: [] },
        }),
        readObservedRootTurn: Effect.succeed({ threadId: "parent-thread", turnId: "native-root" }),
        steerTurn: (turnId) =>
          Effect.sync(() => {
            sends.push(turnId);
            return { turnId };
          }),
      });
      assert.equal(result.turnId, "native-root");
      assert.deepEqual(sends, ["native-root"]);
      yield* readCodexActiveTurn({
        providerThreadId: "parent-thread",
        readThread: unsupportedHistory(),
        readThreadMetadata: Effect.succeed({
          thread: { id: "parent-thread", status: { type: "active" } },
        }),
        readObservedRootTurn: Effect.succeed({ threadId: "child-thread", turnId: "child-turn" }),
      }).pipe(Effect.flip);
    }),
  );

  it.effect(
    "does not resend a stale native observation after an unsupported-history rejection",
    () =>
      Effect.gen(function* () {
        const sends: string[] = [];
        yield* steerCodexActiveTurn({
          providerThreadId: "parent-thread",
          readThread: unsupportedHistory(),
          readThreadMetadata: Effect.succeed({
            thread: { id: "parent-thread", status: { type: "active" } },
          }),
          readObservedRootTurn: Effect.succeed({
            threadId: "parent-thread",
            turnId: "stale-native",
          }),
          steerTurn: (turnId) =>
            Effect.sync(() => {
              sends.push(turnId);
            }).pipe(Effect.andThen(staleRejection())),
        }).pipe(Effect.flip);
        assert.deepEqual(sends, ["stale-native"]);
      }),
  );

  it.effect("refreshes a native root observation only after definitive provider rejection", () =>
    Effect.gen(function* () {
      const sends: string[] = [];
      let observations = 0;
      const result = yield* steerCodexActiveTurn({
        providerThreadId: "parent-thread",
        readThread: unsupportedHistory(),
        readThreadMetadata: Effect.succeed({
          thread: { id: "parent-thread", status: { type: "active" } },
        }),
        readObservedRootTurn: Effect.sync(() => ({
          threadId: "parent-thread",
          turnId: ++observations === 1 ? "before-race" : "after-race",
        })),
        steerTurn: (turnId) =>
          Effect.gen(function* () {
            sends.push(turnId);
            if (sends.length === 1) return yield* staleRejection();
            return { turnId };
          }),
      });
      assert.equal(result.turnId, "after-race");
      assert.deepEqual(sends, ["before-race", "after-race"]);
    }),
  );

  it.effect("preserves verified full-history reads for detached runtime status", () =>
    Effect.gen(function* () {
      assert.isNull(
        yield* readCodexActiveTurn({
          providerThreadId: "parent-thread",
          readThread: Effect.succeed({
            thread: {
              id: "parent-thread",
              status: { type: "notLoaded" },
              turns: [{ id: "finished", status: "completed" }],
            },
          }),
        }),
      );
    }),
  );

  it.effect("rejects full-history runtime status that conflicts with its turns", () =>
    Effect.gen(function* () {
      for (const [type, turns] of [
        ["active", []],
        ["idle", [active("parent")]],
      ] as const) {
        yield* readCodexActiveTurn({
          providerThreadId: "parent-thread",
          readThread: Effect.succeed({ thread: { id: "parent-thread", status: { type }, turns } }),
        }).pipe(Effect.flip);
      }
    }),
  );

  it.effect("keeps the combined history and metadata read inside one deadline", () =>
    Effect.gen(function* () {
      const fiber = yield* readCodexActiveTurn({
        providerThreadId: "parent-thread",
        readThread: unsupportedHistory(),
        readThreadMetadata: Effect.never,
      }).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("90 seconds");
      assert.include((yield* Fiber.join(fiber)).message, "thread/read timed out");
    }),
  );

  it.effect("recognizes only verified terminal parent history as idle", () =>
    Effect.gen(function* () {
      const read = (turns: Array<{ id: string; status: string }>) =>
        readCodexActiveTurn({
          providerThreadId: "parent-thread",
          readThread: Effect.succeed({ thread: { id: "parent-thread", turns } }),
        });
      assert.isNull(yield* read([]));
      assert.isNull(yield* read([{ id: "finished", status: "completed" }]));
      assert.equal(yield* read([active("actual-parent")]), "actual-parent");
      yield* read([{ id: "unknown", status: "queued" }]).pipe(Effect.flip);
      yield* read([active("one"), active("two")]).pipe(Effect.flip);
    }),
  );
  it.effect("ignores unknown native item variants in the provider history", () =>
    Effect.gen(function* () {
      const result = yield* steerCodexActiveTurn({
        providerThreadId: "parent-thread",
        readThread: Effect.succeed({
          thread: {
            id: "parent-thread",
            turns: [
              { ...active("native-turn"), items: [{ type: "newNativeVariant", future: true }] },
            ],
          },
        }),
        steerTurn: (turnId) => Effect.succeed({ turnId }),
      });
      assert.equal(result.turnId, "native-turn");
    }),
  );

  for (const method of ["thread/read", "turn/steer"] as const) {
    it.effect(`bounds a hung ${method} without replaying a send`, () =>
      Effect.gen(function* () {
        let sends = 0;
        const operation = steerCodexActiveTurn({
          providerThreadId: "parent-thread",
          readThread:
            method === "thread/read"
              ? Effect.never
              : Effect.succeed({ thread: { id: "parent-thread", turns: [active("real-turn")] } }),
          steerTurn: () =>
            Effect.sync(() => {
              sends++;
            }).pipe(Effect.andThen(Effect.never)),
        }).pipe(Effect.flip);
        const fiber = yield* operation.pipe(Effect.forkChild);
        yield* TestClock.adjust(method === "thread/read" ? "90 seconds" : "10 seconds");
        assert.include((yield* Fiber.join(fiber)).message, `${method} timed out`);
        assert.equal(sends, method === "thread/read" ? 0 : 1);
      }),
    );
  }

  it.effect("selects the active provider parent, not the latest completed or child turn", () =>
    Effect.gen(function* () {
      const test = harness({
        snapshots: [[active("real-parent-turn"), { id: "old-turn", status: "completed" }]],
      });
      assert.deepEqual(yield* test.run, { turnId: "real-parent-turn" });
      assert.deepEqual(test.sends, ["real-parent-turn"]);
      assert.equal(test.reads(), 1);
    }),
  );

  for (const scenario of ["completed", "ambiguous", "wrong-thread"] as const) {
    it.effect(`rejects ${scenario} provider state without sending`, () =>
      Effect.gen(function* () {
        const test = harness({
          snapshots:
            scenario === "completed"
              ? [[{ id: "ended", status: "completed" }]]
              : [[active("one"), ...(scenario === "ambiguous" ? [active("two")] : [])]],
          ...(scenario === "wrong-thread" ? { readThreadId: "another-parent" } : {}),
        });
        const error = yield* test.run.pipe(Effect.flip);
        assert.include(error.message, "not sent");
        assert.deepEqual(test.sends, []);
      }),
    );
  }

  it.effect("recovers once after a definitive stale-ID rejection", () =>
    Effect.gen(function* () {
      const test = harness({
        snapshots: [[active("before-race")], [active("after-race")]],
        failures: [staleRejection()],
      });
      assert.deepEqual(yield* test.run, { turnId: "after-race" });
      assert.deepEqual(test.sends, ["before-race", "after-race"]);
      assert.equal(test.reads(), 2);
    }),
  );

  it.effect("reports completion between read and delivery without starting another turn", () =>
    Effect.gen(function* () {
      const test = harness({
        snapshots: [[active("finishing-turn")], []],
        failures: [staleRejection()],
      });
      const error = yield* test.run.pipe(Effect.flip);
      assert.include(error.message, "no unambiguous active turn");
      assert.deepEqual(test.sends, ["finishing-turn"]);
      assert.equal(test.reads(), 2);
    }),
  );

  it.effect("does not resend when a fresh read returns the same rejected turn", () =>
    Effect.gen(function* () {
      const test = harness({ failures: [staleRejection()] });
      yield* test.run.pipe(Effect.flip);
      assert.deepEqual(test.sends, ["real-parent-turn"]);
      assert.equal(test.reads(), 2);
    }),
  );

  it.effect("bounds consecutive turn races to two sends", () =>
    Effect.gen(function* () {
      const test = harness({
        snapshots: [[active("one")], [active("two")], [active("three")]],
        failures: [staleRejection(), staleRejection()],
      });
      yield* test.run.pipe(Effect.flip);
      assert.deepEqual(test.sends, ["one", "two"]);
      assert.equal(test.reads(), 2);
    }),
  );

  for (const error of [
    CodexErrors.CodexAppServerRequestError.internalError("connection lost after send"),
    CodexErrors.CodexAppServerRequestError.fromProtocolError(
      { code: -32600, message: "some other rejected input" },
      "turn/steer",
      "request-2",
    ),
    CodexErrors.CodexAppServerRequestError.invalidRequest("active turn mismatch"),
  ]) {
    it.effect(`does not replay an uncertain or unrelated failure: ${error.message}`, () =>
      Effect.gen(function* () {
        const test = harness({ failures: [error] });
        assert.equal(yield* test.run.pipe(Effect.flip), error);
        assert.equal(test.sends.length, 1);
        assert.equal(test.reads(), 1);
      }),
    );
  }

  it.effect("exposes an inconsistent provider response without replaying delivery", () =>
    Effect.gen(function* () {
      const test = harness({ responseTurnId: "unexpected-turn" });
      const error = yield* test.run.pipe(Effect.flip);
      assert.include(error.message, "delivery is uncertain");
      assert.deepEqual(test.sends, ["real-parent-turn"]);
      assert.equal(test.reads(), 1);
    }),
  );
});
