import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { SpeechRequest } from "./speech.ts";

const valid = Schema.is(SpeechRequest);
describe("voice request validation", () => {
  it.each([
    "call.open",
    "call.upload",
    "call.transcribe",
    "call.deliver",
    "call.interrupt",
    "call.speak",
    "call.played",
  ])("rejects incomplete %s requests", (action) => {
    expect(valid({ action, callId: "synthetic" })).toBe(false);
  });
  it("rejects the removed confirmation protocol", () => {
    expect(
      valid({
        action: "call.confirm",
        callId: "synthetic",
        confirmationId: "tool",
        decision: "yes",
      }),
    ).toBe(false);
  });
  it("retains legacy transport compatibility and closed archive access", () => {
    expect(valid({ action: "acquire" })).toBe(true);
    expect(valid({ action: "call.status", callId: "synthetic" })).toBe(true);
    expect(valid({ action: "call.close", callId: "synthetic" })).toBe(true);
  });
});
