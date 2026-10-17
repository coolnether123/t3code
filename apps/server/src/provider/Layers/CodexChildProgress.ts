import type { ProviderEvent, ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Only the runtime's explicitly cumulative child snapshots can replace each other. */
function snapshotKey(event: ProviderEvent): string | undefined {
  if (event.method !== "collabAgent/notification") return;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload.summary !== "string" || !payload.summary) return;
  const wire = payload.wire as Record<string, unknown> | undefined;
  const params = wire?.params as Record<string, unknown> | undefined;
  if (
    typeof wire?.method !== "string" ||
    !wire.method.endsWith("/delta") ||
    typeof params?.delta !== "string"
  )
    return;
  return JSON.stringify([wire.method, params.turnId, params.itemId]);
}

/**
 * Limit child display snapshots before they enter the durable ingestion queue.
 * Parent content bypasses the timer. Child boundaries flush only their child.
 * One slot per child prevents a stream of item ids from growing a backlog.
 */
export const makeCodexChildProgress = Effect.fn("makeCodexChildProgress")(function* (
  emit: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>,
) {
  const lock = yield* Semaphore.make(1);
  const children = new Map<
    string,
    { readonly streamKey: string; pending?: ProviderRuntimeEvent | undefined }
  >();

  const flush = Effect.fnUntraced(function* (taskId?: string) {
    const events: Array<ProviderRuntimeEvent> = [];
    for (const [id, child] of children) {
      if (taskId !== undefined && id !== taskId) continue;
      if (child.pending) {
        events.push(child.pending);
        child.pending = undefined;
      }
    }
    if (events.length > 0) yield* emit(events);
  });

  // A fixed cadence cannot be postponed indefinitely by continuous deltas.
  // The session scope interrupts the timer and flushes its final snapshots.
  yield* Effect.forever(
    Effect.sleep("1 second").pipe(Effect.andThen(lock.withPermit(flush()))),
  ).pipe(
    // Serialize the enqueue with boundaries as well as the map mutation.
    // Taking a pending snapshot must not allow a terminal event to overtake it.
    // The fixed sleep itself must not hold the permit.
    Effect.ensuring(lock.withPermit(flush())),
    Effect.forkScoped({ startImmediately: true }),
  );

  return Effect.fnUntraced(function* (
    source: ProviderEvent,
    events: ReadonlyArray<ProviderRuntimeEvent>,
  ) {
    const event = events[0];
    const streamKey = snapshotKey(source);
    if (events.length === 1 && event?.type === "task.progress" && streamKey !== undefined) {
      const taskId = event.payload.taskId;
      const previous = children.get(taskId);
      if (previous?.streamKey === streamKey) {
        previous.pending = event;
        return;
      }
      if (previous?.pending) {
        const pending = previous.pending;
        previous.pending = undefined;
        yield* emit([pending]);
      }
      children.set(taskId, { streamKey });
      yield* emit(events);
      return;
    }

    if (source.method.startsWith("collabAgent/")) {
      for (const event of events) {
        if (
          event.type === "task.started" ||
          event.type === "task.progress" ||
          event.type === "task.updated" ||
          event.type === "task.completed"
        ) {
          yield* flush(event.payload.taskId);
          children.delete(event.payload.taskId);
        }
      }
    } else if (
      events.some(
        (event) =>
          event.type === "turn.completed" ||
          event.type === "turn.aborted" ||
          event.type === "session.exited",
      )
    ) {
      yield* flush();
      children.clear();
    }
    yield* emit(events);
  }, lock.withPermit);
});
