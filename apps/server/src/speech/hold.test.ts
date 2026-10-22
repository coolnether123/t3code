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
describe("silent hold completion", () => {
  it("finishes on the complete marker without waiting 30 minutes for a provider terminal", () => {
    const guard = new HoldTurnGuard();
    expect(guard.accept(delta("<otis-ho"), "<otis-ho")?.stop).toBe(false);
    const result = guard.accept(delta("ld/>", "last"), "<otis-hold/>");
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
  });
});
