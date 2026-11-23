import { expect, it } from "@effect/vitest";
import { EnvironmentId, type OtisFleetEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createOtisTreeAtoms } from "./otisTree.ts";

it.effect("a mounted environment atom switches to stock and back on the same subscription", () =>
  Effect.gen(function* () {
    const frames = yield* Queue.unbounded<OtisFleetEvent>();
    const session = {
      client: { "otis.subscribe": () => Stream.fromQueue(frames) },
    } as unknown as RpcSession;
    const supervisor = Layer.mock(EnvironmentSupervisor.EnvironmentSupervisor)({
      session: yield* SubscriptionRef.make(Option.some(session)),
    });
    const runtime = Atom.runtime(
      Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        followStream: (_id, source) => source.pipe(Stream.provide(supervisor)),
      }),
    );
    const registry = AtomRegistry.make();
    const { tree } = createOtisTreeAtoms(runtime);
    const atom = tree({ environmentId: EnvironmentId.make("home"), input: {} });
    const first = yield* Deferred.make<void>();
    const down = yield* Deferred.make<void>();
    const back = yield* Deferred.make<void>();
    let firstSnapshot = false;
    const unsubscribe = registry.subscribe(
      atom,
      (result) => {
        if (!AsyncResult.isSuccess(result)) return;
        const state = result.value;
        if (
          state.sidebar === "stock" &&
          firstSnapshot &&
          state.explanation === "Otis is not answering. Showing all chats."
        ) {
          Deferred.doneUnsafe(down, Exit.void);
        }
        if (state.sidebar === "otis") {
          firstSnapshot = true;
          Deferred.doneUnsafe(state.seq === 1 ? first : back, Exit.void);
        }
      },
      { immediate: true },
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribe();
        registry.dispose();
      }),
    );
    const snapshot = { type: "snapshot", nodes: [], waiting: null, load: null } as const;
    yield* Queue.offer(frames, { ...snapshot, seq: 1 });
    yield* Deferred.await(first);
    yield* Queue.offer(frames, { type: "unavailable" });
    yield* Deferred.await(down);
    yield* Queue.offer(frames, { ...snapshot, seq: 2 });
    yield* Deferred.await(back);
    const result = registry.get(atom);
    expect(AsyncResult.isSuccess(result) && result.value.explanation).toBeNull();
  }),
);
