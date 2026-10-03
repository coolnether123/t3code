import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { makeDrainableWorker } from "./DrainableWorker.ts";

describe("makeDrainableWorker", () => {
  it.live("cancels active processing and stops intake when its scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const started = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        const processed: string[] = [];
        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            processed.push(item);
            yield* Deferred.succeed(started, undefined);
            yield* Effect.never;
          }).pipe(Effect.ensuring(Deferred.succeed(cancelled, undefined))),
        ).pipe(Scope.provide(scope));
        yield* worker.enqueue("first");
        yield* Deferred.await(started);
        yield* worker.enqueue("second");
        yield* Scope.close(scope, Exit.void);
        expect(yield* Deferred.isDone(cancelled)).toBe(true);
        expect(processed).toEqual(["first"]);
      }),
    ),
  );

  it.live.each(["interrupt", "failure", "defect"] as const)(
    "keeps consuming after an item exits with %s",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          const processed: string[] = [];
          const worker = yield* makeDrainableWorker((item: string) => {
            if (item === "first") {
              if (failure === "interrupt") return Effect.interrupt;
              if (failure === "failure") return Effect.fail("item failed");
              return Effect.die("item defect");
            }
            return Effect.sync(() => {
              processed.push(item);
            });
          });
          yield* worker.enqueue("first");
          yield* worker.enqueue("second");
          yield* worker.drain;
          expect(processed).toEqual(["second"]);
        }),
      ),
  );

  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});
