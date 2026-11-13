import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { SpeechRequest, SpeechResponse } from "./speech.ts";

const valid = Schema.is(SpeechRequest);
const decodeResponse = Schema.decodeUnknownSync(SpeechResponse);
const validResponse = Schema.is(SpeechResponse);
describe("voice request validation", () => {
  it("retains separate remembered and default call models across the response boundary", () => {
    const pair = (model: string) => ({
      voice: { instanceId: "claudeAgent", model },
      operator: { instanceId: "codex", model },
    });
    const response = { models: pair("remembered"), defaultModels: pair("default") };
    expect(decodeResponse(response)).toEqual(response);
    expect(validResponse({})).toBe(true);
  });
  it.each([
    "call.open",
    "call.upload",
    "call.transcribe",
    "call.deliver",
    "call.say",
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

it("validates typed call input while keeping recording metadata optional", () => {
  expect(valid({ action: "call.say", callId: "call", utteranceId: "typed", text: "Hello" })).toBe(
    true,
  );
  expect(valid({ action: "call.say", callId: "call", utteranceId: "typed", text: "  " })).toBe(
    false,
  );
});
