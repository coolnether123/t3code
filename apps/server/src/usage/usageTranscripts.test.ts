import { describe, expect, it } from "@effect/vitest";

import { initialCodexScanState, parseClaudeLine, parseCodexLine } from "./usageTranscripts.ts";

function claudeLine(model: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-19T18:00:00.000Z",
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    message: {
      id: "msg_1",
      model,
      usage: { input_tokens: 2, output_tokens: 3 },
    },
  });
}

describe("parseClaudeLine", () => {
  it("skips Claude Code's local placeholder model", () => {
    expect(parseClaudeLine(claudeLine("<synthetic>"))).toBeNull();
    expect(parseClaudeLine(claudeLine("claude-fable-5"))?.model).toBe("claude-fable-5");
  });
});

describe("Codex accounting adapter", () => {
  const counter = (input: number, output: number, totalInput = input, totalOutput = output) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T10:00:00Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: input, output_tokens: output },
          total_token_usage: { input_tokens: totalInput, output_tokens: totalOutput },
        },
      },
    });

  it("reconciles cumulative counters while preserving native run and turn IDs", () => {
    const state = initialCodexScanState();
    parseCodexLine(
      JSON.stringify({
        type: "session_meta",
        payload: { id: "native-run", model_provider: "openai" },
      }),
      state,
    );
    parseCodexLine(
      JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-6-astra", turn_id: "native-turn" },
      }),
      state,
    );
    expect(parseCodexLine(counter(100, 20), state)).toMatchObject({
      nativeSessionId: "native-run",
      turnId: "native-turn",
      unresolvedServiceTierTurnId: "native-turn",
      totals: { uncachedInputTokens: 100, outputTokens: 20 },
    });
    expect(parseCodexLine(counter(20, 5, 100, 20), state)).toBeNull();
    expect(parseCodexLine(counter(10, 2, 130, 28), state)).toBeNull();
    expect(state.providerState?.malformedRecords).toBe(1);
    expect(parseCodexLine(counter(5, 1, 135, 29), state)?.totals.outputTokens).toBe(1);
  });

  it("carries applied thread tiers and retains explicit turn-tier metadata", () => {
    const state = initialCodexScanState();
    parseCodexLine(
      JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-6-astra", turn_id: "turn-a", service_tier: "priority" },
      }),
      state,
    );
    expect(parseCodexLine(counter(10, 2), state)?.serviceTier).toBe("priority");
    parseCodexLine(
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: { service_tier: "ultrafast" },
        },
      }),
      state,
    );
    expect(parseCodexLine(counter(5, 1, 15, 3), state)).toMatchObject({
      speed: "ultrafast",
      serviceTier: "ultrafast",
      serviceTierSource: "transcript",
    });
  });
});
