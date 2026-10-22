import type { ProviderRuntimeEvent } from "@t3tools/contracts";

/** A complete silent-yield control message is terminal even if the provider keeps its stream open. */
export class HoldTurnGuard {
  private closed = new Set<string>();

  accept(
    event: ProviderRuntimeEvent,
    raw: string,
  ): { event: ProviderRuntimeEvent; stop: boolean } | undefined {
    const key = `${event.threadId}:${event.turnId ?? "pending"}`;
    if (this.closed.has(key)) return undefined;
    const hold =
      (event.type === "content.delta" || event.type === "item.completed") &&
      /^\s*<otis-hold\s*(?:\/>|>\s*(?:<\/otis-hold>)?)\s*$/.test(raw);
    if (hold || event.type === "turn.completed" || event.type === "runtime.error") {
      this.closed.add(key);
      if (this.closed.size > 512) this.closed.delete(this.closed.values().next().value!);
    }
    if (!hold) return { event, stop: false };
    return {
      event: {
        ...event,
        eventId: `${event.eventId}:hold`,
        type: "turn.completed",
        payload: { state: "completed" },
      },
      stop: true,
    };
  }
}
