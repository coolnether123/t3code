import { describe, expect, it } from "vite-plus/test";
import { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { HoldTurnGuard } from "./hold.ts";

const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const delta = (text: string, id = "delta") =>
  decodeEvent({
    eventId: id,
    type: "content.delta",
    provider: "claudeAgent",
    threadId: "synthetic-session",
    turnId: "synthetic-turn",
    createdAt: "2026-10-22T09:00:00Z",
    payload: { streamKind: "assistant_text", delta: text },
  });
const completed = () =>
  decodeEvent({
    ...delta(""),
    eventId: "item-final",
    type: "item.completed",
    payload: { itemType: "assistant_message", detail: "<otis-hold/>" },
  });
describe("silent hold completion", () => {
  it("does not poison later unnumbered events after a new turn starts", () => {
    const guard = new HoldTurnGuard();
    const { turnId: _turnId, ...anonymous } = delta("<otis-hold/>");
    guard.accept(anonymous, "<otis-hold/>");
    expect(guard.expire(anonymous)?.stop).toBe(true);
    guard.accept(
      decodeEvent({ ...delta(""), type: "turn.started", turnId: "next", payload: {} }),
      "",
    );
    expect(guard.accept(anonymous, "Hello.")?.event.type).toBe("content.delta");
  });
  it("expires a missing item boundary, but invalidates the fallback on continuation or a new turn", () => {
    const guard = new HoldTurnGuard();
    const hold = delta("<otis-hold/>");
    expect(guard.accept(hold, "<otis-hold/>")?.pending).toBe(true);
    expect(guard.expire(hold)?.event.type).toBe("turn.completed");
    expect(guard.expire(hold)).toBeUndefined();
    const continuing = new HoldTurnGuard();
    continuing.accept(hold, "<otis-hold/>");
    continuing.accept(delta("<otis-delegate>"), "<otis-hold/><otis-delegate>");
    expect(continuing.expire(hold)).toBeUndefined();
    continuing.accept(hold, "<otis-hold/>");
    continuing.accept(
      decodeEvent({ ...hold, type: "turn.started", turnId: "next", payload: {} }),
      "",
    );
    expect(continuing.expire(hold)).toBeUndefined();
  });
  it("finishes on the complete marker without waiting 30 minutes for a provider terminal", () => {
    const guard = new HoldTurnGuard();
    expect(guard.accept(delta("<otis-ho"), "<otis-ho")?.stop).toBe(false);
    expect(guard.accept(delta("ld/>", "last"), "<otis-hold/>")?.stop).toBe(false);
    const result = guard.accept(completed(), "<otis-hold/>");
    expect(result?.stop).toBe(true);
    expect(result?.event).toMatchObject({
      type: "turn.completed",
      payload: { state: "completed" },
    });
    expect(guard.accept(delta("late"), "late")).toBeUndefined();
    expect(guard.accept(result!.event, "<otis-hold/>")).toBeUndefined();
  });
  it("leaves substantive replies and delegation to normal completion", () => {
    const guard = new HoldTurnGuard();
    expect(guard.accept(delta("Hello."), "Hello.")?.stop).toBe(false);
    expect(
      guard.accept(
        delta("<otis-hold/>"),
        '<otis-hold/><otis-delegate>{"intent":"Check"}</otis-delegate>',
      )?.stop,
    ).toBe(false);
    expect(
      guard.accept(completed(), '<otis-hold/><otis-delegate>{"intent":"Check"}</otis-delegate>')
        ?.stop,
    ).toBe(false);
  });
});
