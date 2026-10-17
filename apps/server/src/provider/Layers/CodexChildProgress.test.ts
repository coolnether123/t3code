import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  RuntimeTaskId,
  ThreadId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { makeCodexChildProgress } from "./CodexChildProgress.ts";

function snapshot(parent: string, child: string, text: string, item = "message") {
  const base = {
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make(parent),
    createdAt: "2026-10-17T00:00:00.000Z",
  };
  const source: ProviderEvent = {
    ...base,
    id: EventId.make(`${parent}:${child}:${item}:${text}`),
    kind: "notification",
    method: "collabAgent/notification",
    payload: {
      agentThreadId: child,
      summary: text,
      wire: {
        method: "item/agentMessage/delta",
        params: { threadId: child, turnId: "child-turn", itemId: item, delta: text.slice(-1) },
      },
    },
  };
  const event: ProviderRuntimeEvent = {
    ...base,
    eventId: source.id,
    type: "task.progress",
    providerRefs: {
      providerThreadId: child,
      providerTurnId: "child-turn",
      providerItemId: ProviderItemId.make(item),
    },
    payload: {
      taskId: RuntimeTaskId.make(child),
      parentAgentId: parent,
      description: child,
      summary: text,
      timelineBypass: true,
    },
  };
  return { source, event };
}

function record(events: Array<ProviderRuntimeEvent>) {
  return (batch: ReadonlyArray<ProviderRuntimeEvent>) =>
    Effect.sync(() => {
      events.push(...batch);
    });
}

it.effect(
  "bounds six child floods under two parents while retaining final text and ownership",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delivered: Array<ProviderRuntimeEvent> = [];
        const parents = ["alpha", "bravo"];
        const forwarders = yield* Effect.forEach(parents, () =>
          makeCodexChildProgress(record(delivered)),
        );
        const rawCount = 2 * 3 * 2_000;
        for (let chunk = 1; chunk <= 2_000; chunk++) {
          for (const [index, parent] of parents.entries()) {
            for (let child = 1; child <= 3; child++) {
              const value = snapshot(
                parent,
                `${parent}-${child}`,
                `FULL:${parent}:${child}:${chunk}`,
              );
              yield* forwarders[index]!(value.source, [value.event]);
            }
          }
        }
        assert.strictEqual(delivered.length, 6);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(delivered.length, 12);
        assert.isBelow(delivered.length, rawCount / 100);
        for (const parent of parents) {
          for (let child = 1; child <= 3; child++) {
            const taskId = `${parent}-${child}`;
            const last = delivered.findLast(
              (event) => event.type === "task.progress" && event.payload.taskId === taskId,
            );
            assert.strictEqual(last?.threadId, parent);
            assert.strictEqual(last?.providerRefs?.providerThreadId, taskId);
            assert.strictEqual(
              last?.type === "task.progress" && last.payload.parentAgentId,
              parent,
            );
            assert.strictEqual(
              last?.type === "task.progress" && last.payload.summary,
              `FULL:${parent}:${child}:2000`,
            );
          }
        }
      }),
    ),
);

it.effect("flushes on a fixed cadence even while cumulative input never stops", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delivered: Array<ProviderRuntimeEvent> = [];
      const forward = yield* makeCodexChildProgress(record(delivered));
      for (let chunk = 1; chunk <= 30; chunk++) {
        const value = snapshot("parent", "child", `text-${chunk}`);
        yield* forward(value.source, [value.event]);
        yield* TestClock.adjust("100 millis");
      }
      assert.deepStrictEqual(
        delivered.map((event) =>
          event.type === "task.progress" ? event.payload.summary : event.type,
        ),
        ["text-1", "text-10", "text-20", "text-30"],
      );
    }),
  ),
);

it.effect(
  "flushes before stream changes and child terminal boundaries while parent content bypasses",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delivered: Array<ProviderRuntimeEvent> = [];
        const forward = yield* makeCodexChildProgress(record(delivered));
        for (const text of ["first", "last snapshot"]) {
          const value = snapshot("parent", "child", text);
          yield* forward(value.source, [value.event]);
        }
        const next = snapshot("parent", "child", "new item", "next");
        yield* forward(next.source, [next.event]);
        assert.deepStrictEqual(
          delivered.map((event) => event.eventId),
          [
            snapshot("parent", "child", "first").event.eventId,
            snapshot("parent", "child", "last snapshot").event.eventId,
            next.event.eventId,
          ],
        );

        const pending = snapshot("parent", "child", "pending latest", "next");
        yield* forward(pending.source, [pending.event]);
        const root: ProviderRuntimeEvent = {
          ...next.event,
          eventId: EventId.make("parent-steer"),
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: "STEERING ACKNOWLEDGED" },
        };
        yield* forward({ ...next.source, method: "item/agentMessage/delta" }, [root]);
        assert.strictEqual(delivered.at(-1), root);
        assert.notInclude(delivered, pending.event);

        const final = snapshot("parent", "child", "FINAL SNAPSHOT", "next");
        yield* forward(final.source, [final.event]);
        const later = snapshot("parent", "child", "FINAL SNAPSHOT COMPLETE", "next");
        yield* forward(later.source, [later.event]);
        const completed: ProviderRuntimeEvent = {
          ...final.event,
          eventId: EventId.make("child-terminal"),
          type: "task.updated",
          payload: { taskId: RuntimeTaskId.make("child"), status: "idle" },
        };
        yield* forward({ ...final.source, method: "collabAgent/turnCompleted" }, [completed]);
        assert.strictEqual(delivered.at(-2), later.event);
        assert.strictEqual(delivered.at(-1), completed);
      }),
    ),
);

it.effect("does not coalesce noncumulative deltas or meaningful child boundaries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delivered: Array<ProviderRuntimeEvent> = [];
      const forward = yield* makeCodexChildProgress(record(delivered));
      const value = snapshot("parent", "child", "text");
      for (const method of [
        "collabAgent/started",
        "collabAgent/turnStarted",
        "collabAgent/item",
        "collabAgent/tokenUsage",
        "collabAgent/statusChanged",
        "error",
        "item/commandExecution/requestApproval",
        "collabAgent/closed",
      ]) {
        yield* forward({ ...value.source, method }, [value.event]);
        yield* forward({ ...value.source, method }, [value.event]);
      }
      const noncumulative = {
        ...value.source,
        payload: {
          wire: {
            method: "item/agentMessage/delta",
            params: { delta: "content" },
          },
        },
      };
      yield* forward(noncumulative, [value.event]);
      yield* forward(noncumulative, [value.event]);
      assert.strictEqual(delivered.length, 18);
    }),
  ),
);

it.effect("session close flushes once and cancels the timer with no surviving wakeups", () =>
  Effect.gen(function* () {
    const delivered: Array<ProviderRuntimeEvent> = [];
    const sessionScope = yield* Scope.make();
    const clock = yield* Clock.Clock;
    let sleeps = 0;
    const trackedClock: Clock.Clock = {
      ...clock,
      sleep: (duration) =>
        Effect.suspend(() => {
          sleeps++;
          return clock.sleep(duration);
        }),
    };
    const forward = yield* makeCodexChildProgress(record(delivered)).pipe(
      Effect.provideService(Scope.Scope, sessionScope),
      Effect.provideService(Clock.Clock, trackedClock),
    );
    for (const text of ["first", "latest on shutdown"]) {
      const value = snapshot("parent", "child", text);
      yield* forward(value.source, [value.event]);
    }
    assert.strictEqual(sleeps, 1);
    assert.strictEqual(delivered.length, 1);
    yield* Scope.close(sessionScope, Exit.void);
    assert.strictEqual(delivered.length, 2);
    const last = delivered.at(-1);
    assert.strictEqual(
      last?.type === "task.progress" && last.payload.summary,
      "latest on shutdown",
    );
    yield* TestClock.adjust("1 minute");
    assert.strictEqual(delivered.length, 2);
    assert.strictEqual(sleeps, 1);
  }),
);

it.effect("one child's boundary does not flush or reset another child's slot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delivered: Array<ProviderRuntimeEvent> = [];
      const forward = yield* makeCodexChildProgress(record(delivered));
      for (const text of ["first", "pending"]) {
        const value = snapshot("parent", "child-a", text);
        yield* forward(value.source, [value.event]);
      }
      const other = snapshot("parent", "child-b", "other boundary");
      yield* forward({ ...other.source, method: "collabAgent/item" }, [other.event]);
      const latest = snapshot("parent", "child-a", "latest");
      yield* forward(latest.source, [latest.event]);
      assert.strictEqual(delivered.length, 2);
      yield* TestClock.adjust("1 second");
      assert.strictEqual(delivered.at(-1), latest.event);
    }),
  ),
);

it.effect("a terminal cannot overtake a timer flush whose enqueue is still in flight", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delivered: Array<ProviderRuntimeEvent> = [];
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const forward = yield* makeCodexChildProgress((events) =>
        Effect.gen(function* () {
          if (
            events.some(
              (event) => event.type === "task.progress" && event.payload.summary === "latest",
            )
          ) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          delivered.push(...events);
        }),
      );
      for (const text of ["first", "latest"]) {
        const value = snapshot("parent", "child", text);
        yield* forward(value.source, [value.event]);
      }
      const clockFiber = yield* TestClock.adjust("1 second").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const value = snapshot("parent", "child", "unused");
      const terminal: ProviderRuntimeEvent = {
        ...value.event,
        eventId: EventId.make("terminal"),
        type: "session.exited",
        payload: {},
      };
      const terminalFiber = yield* forward({ ...value.source, method: "session/closed" }, [
        terminal,
      ]).pipe(Effect.forkChild({ startImmediately: true }));
      assert.strictEqual(delivered.length, 1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(clockFiber);
      yield* Fiber.join(terminalFiber);
      assert.deepStrictEqual(
        delivered.map((event) => event.eventId),
        [
          snapshot("parent", "child", "first").event.eventId,
          snapshot("parent", "child", "latest").event.eventId,
          terminal.eventId,
        ],
      );
    }),
  ),
);

it.effect("does not blindly replay a snapshot after an unknown enqueue defect", () =>
  Effect.gen(function* () {
    const sessionScope = yield* Scope.make();
    let attempts = 0;
    const forward = yield* makeCodexChildProgress(() =>
      Effect.sync(() => {
        if (++attempts === 2) throw new Error("delivery outcome unknown");
      }),
    ).pipe(Effect.provideService(Scope.Scope, sessionScope));
    for (const text of ["first", "latest"]) {
      const value = snapshot("parent", "child", text);
      yield* forward(value.source, [value.event]);
    }
    const changed = snapshot("parent", "child", "new stream", "other-item");
    const result = yield* Effect.exit(forward(changed.source, [changed.event]));
    assert.isTrue(Exit.isFailure(result));
    yield* Scope.close(sessionScope, Exit.void);
    assert.strictEqual(attempts, 2);
  }),
);
