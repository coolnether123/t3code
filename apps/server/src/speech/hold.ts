import { EventId, type ProviderRuntimeEvent } from "@t3tools/contracts";

/** A complete silent-yield control message is terminal even if the provider keeps its stream open. */
export class HoldTurnGuard {
  private closed = new Set<string>();
  private pending = new Map<string, ProviderRuntimeEvent>();

  expire(event: ProviderRuntimeEvent) {
    const key = `${event.threadId}:${event.turnId ?? "pending"}`;
    if (this.pending.get(key) !== event || this.closed.has(key)) return;
    this.pending.delete(key);
    return this.finish(event);
  }

  private finish(event: ProviderRuntimeEvent): { event: ProviderRuntimeEvent; stop: boolean } {
    const key = `${event.threadId}:${event.turnId ?? "pending"}`;
    this.closed.add(key);
    if (this.closed.size > 512) this.closed.delete(this.closed.values().next().value!);
    return {
      event: {
        ...event,
        eventId: EventId.make(`${event.eventId}:hold`),
        type: "turn.completed" as const,
        payload: { state: "completed" as const },
      },
      stop: true,
    };
  }

  accept(
    event: ProviderRuntimeEvent,
    raw: string,
  ): { event: ProviderRuntimeEvent; stop: boolean; pending?: boolean } | undefined {
    const key = `${event.threadId}:${event.turnId ?? "pending"}`;
    if (this.closed.has(key)) return undefined;
    if (event.type === "turn.started")
      for (const [pendingKey, pending] of this.pending)
        if (pending.threadId === event.threadId) this.pending.delete(pendingKey);
    const marker = /^\s*<otis-hold\s*(?:\/>|>\s*(?:<\/otis-hold>)?)\s*$/.test(raw);
    if (event.type === "content.delta") {
      this.pending.delete(key);
      if (marker) this.pending.set(key, event);
    }
    const hold =
      event.type === "item.completed" && event.payload.itemType === "assistant_message" && marker;
    if (hold || event.type === "turn.completed" || event.type === "runtime.error") {
      this.pending.delete(key);
      this.closed.add(key);
      if (this.closed.size > 512) this.closed.delete(this.closed.values().next().value!);
    }
    if (!hold) return { event, stop: false, pending: this.pending.get(key) === event };
    return this.finish(event);
  }
}
