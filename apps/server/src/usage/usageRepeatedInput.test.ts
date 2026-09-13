import { describe, expect, it } from "@effect/vitest";

import {
  aggregateRepeatedInputObservations,
  createRepeatedInputCatalog,
  estimateRepeatedInputCost,
  initialRepeatedInputParserState,
  parseCodexRepeatedInputLine,
  parseCodexRepeatedInputLineDetailed,
  type RepeatedInputObservation,
} from "./usageRepeatedInput.ts";
import { parseRateTable } from "./usagePricing.ts";

const skillText = "# Example skill\nFollow the repository instructions exactly.\n";
const skillPath = "C:/Users/example/.codex/skills/example/SKILL.md";
const catalog = createRepeatedInputCatalog([
  { path: skillPath, content: skillText, tokenCount: 17 },
]);

const line = (payload: unknown, timestamp = "2026-09-13T01:00:00.000Z") =>
  JSON.stringify({ timestamp, type: "response_item", payload });

function usageLine() {
  return JSON.stringify({
    timestamp: "2026-09-13T00:59:59.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          cache_write_input_tokens: 10,
          output_tokens: 5,
        },
      },
    },
  });
}

describe("Codex repeated-input detection", () => {
  it("recognizes exact skill payloads as confirmed without returning source text", () => {
    const state = initialRepeatedInputParserState();
    parseCodexRepeatedInputLine(
      JSON.stringify({
        timestamp: "2026-09-13T00:59:00.000Z",
        type: "session_meta",
        payload: { id: "session-a", cwd: "C:/project" },
      }),
      state,
    );
    parseCodexRepeatedInputLine(
      JSON.stringify({
        timestamp: "2026-09-13T00:59:01.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-a", model: "gpt-5.6-sol" },
      }),
      state,
    );
    parseCodexRepeatedInputLine(usageLine(), state);

    const observations = parseCodexRepeatedInputLine(
      line({
        type: "custom_tool_call_output",
        id: "tool-output-a",
        output: `loaded file:\n${skillText}`,
      }),
      state,
      { catalog },
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      sourceKind: "skill",
      displayName: "example",
      confidence: "confirmedPayload",
      model: "gpt-5.6-sol",
      sessionId: "session-a",
      turnId: "turn-a",
      directTokens: { exact: 17, estimated: 0, cached: 0, cacheWrite: 0 },
      fullSessionInputTokens: { exact: 50, cached: 40, cacheWrite: 10 },
    });
    expect(JSON.stringify(observations)).not.toContain(skillText);
  });

  it("keeps references and likely reads below confirmed payload evidence", () => {
    const state = initialRepeatedInputParserState();
    const reference = parseCodexRepeatedInputLine(
      line({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: `The ${skillPath} skill is mandatory.` }],
      }),
      state,
      { catalog },
    );
    const read = parseCodexRepeatedInputLine(
      line({
        type: "custom_tool_call",
        id: "read-a",
        name: "exec",
        input: `Get-Content -Raw '${skillPath}'`,
      }),
      state,
      { catalog },
    );

    expect(reference).toHaveLength(1);
    expect(reference[0]?.confidence).toBe("reference");
    expect(read.some((observation) => observation.confidence === "likelyRead")).toBe(true);
    expect(read.some((observation) => observation.sourceKind === "toolOperation")).toBe(true);
    expect(reference[0]?.directTokens).toEqual({
      exact: 0,
      estimated: 0,
      cached: 0,
      cacheWrite: 0,
      unknown: 0,
    });
  });

  it("requires an exact path when a skill name has multiple revisions", () => {
    const revisions = createRepeatedInputCatalog([
      {
        path: "C:/cache/v1/skills/unslop/SKILL.md",
        content: "revision one",
        tokenCount: 2,
      },
      {
        path: "C:/cache/v2/skills/unslop/SKILL.md",
        content: "revision two",
        tokenCount: 2,
      },
    ]);
    expect(revisions.matchPathEvidence("load the unslop skill")).toEqual([]);
    expect(revisions.ambiguousPathEvidence("load the unslop skill")).toBe(1);
    expect(
      revisions.matchPathEvidence("Get-Content C:/cache/v2/skills/unslop/SKILL.md"),
    ).toMatchObject([{ contentHash: expect.any(String), displayName: "unslop" }]);

    const parsed = parseCodexRepeatedInputLineDetailed(
      line({ type: "custom_tool_call", id: "ambiguous", name: "exec", input: "load unslop skill" }),
      initialRepeatedInputParserState(),
      { catalog: revisions },
    );
    expect(parsed.observations.every((entry) => entry.sourceKind !== "skill")).toBe(true);
    expect(parsed.gaps).toEqual([expect.objectContaining({ reason: "unattributed", count: 1 })]);
  });

  it("does not turn repeated chat text into a reusable source", () => {
    const state = initialRepeatedInputParserState();
    const first = parseCodexRepeatedInputLine(
      line({ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }),
      state,
      { catalog },
    );
    const second = parseCodexRepeatedInputLine(
      line({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }],
      }),
      state,
      { catalog },
    );
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });

  it("supports named developer blocks and typed tool operations", () => {
    const state = initialRepeatedInputParserState();
    const observations = parseCodexRepeatedInputLine(
      line({
        type: "developer_block",
        name: "review-policy",
        content: "Review changed files before replying.",
      }),
      state,
      { tokenizer: { countTokens: (value) => value.length } },
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      sourceKind: "developerBlock",
      displayName: "review-policy",
      directTokens: { exact: "Review changed files before replying.".length },
    });
  });

  it("recognizes an explicitly tagged AGENTS instruction block", () => {
    const state = initialRepeatedInputParserState();
    const content = "Read the workspace guide before editing.";
    const observations = parseCodexRepeatedInputLine(
      line({
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `# AGENTS.md instructions for C:/project\n<INSTRUCTIONS>\n${content}\n</INSTRUCTIONS>`,
          },
        ],
      }),
      state,
      { tokenizer: { countTokens: () => 9 } },
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      sourceKind: "instruction",
      displayName: "AGENTS.md",
      confidence: "confirmedPayload",
      directTokens: { exact: 9 },
    });
    expect(JSON.stringify(observations)).not.toContain(content);
  });

  it("retains malformed and oversized records as coverage gaps", () => {
    const state = initialRepeatedInputParserState();
    expect(parseCodexRepeatedInputLineDetailed("not-json", state)).toMatchObject({
      gaps: [{ reason: "malformed", count: 1 }],
    });
    expect(
      parseCodexRepeatedInputLineDetailed("x".repeat(20), state, { maxPayloadBytes: 10 }),
    ).toMatchObject({ gaps: [{ reason: "oversized", count: 1 }] });
  });

  it("retains missing model and tokenizer attribution for reported items", () => {
    const state = initialRepeatedInputParserState();
    const result = parseCodexRepeatedInputLineDetailed(
      line({
        type: "custom_tool_call_output",
        id: "output-without-model",
        output: skillText,
      }),
      state,
      { catalog: createRepeatedInputCatalog([{ path: skillPath, content: skillText }]) },
    );
    expect(result.observations[0]?.model).toBeNull();
    const aggregate = aggregateRepeatedInputObservations(result.observations, { rates: new Map() });
    expect(aggregate.coverageGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "missingModel" }),
        expect.objectContaining({ reason: "missingTokenizer" }),
      ]),
    );
  });
});

describe("repeated-input attribution", () => {
  it("upgrades a read command to its confirmed output without counting it twice", () => {
    const state = initialRepeatedInputParserState();
    parseCodexRepeatedInputLine(
      JSON.stringify({
        timestamp: "2026-09-13T00:59:00.000Z",
        type: "session_meta",
        payload: { id: "session-a" },
      }),
      state,
    );
    parseCodexRepeatedInputLine(
      JSON.stringify({
        timestamp: "2026-09-13T00:59:01.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-a", model: "gpt-5.6-sol" },
      }),
      state,
    );
    const read = parseCodexRepeatedInputLine(
      line({
        type: "custom_tool_call",
        id: "read-a",
        name: "exec",
        input: `Get-Content -Raw '${skillPath}'`,
      }),
      state,
      { catalog },
    );
    const output = parseCodexRepeatedInputLine(
      line({ type: "custom_tool_call_output", id: "output-a", output: skillText }),
      state,
      { catalog },
    );
    const result = aggregateRepeatedInputObservations([...read, ...output], { rates: new Map() });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceKind: "skill",
      confidence: "confirmedPayload",
      occurrences: 1,
      confidenceCounts: { reference: 0, likelyRead: 0, confirmedPayload: 1 },
    });
  });

  it("requires two exact tool-operation payloads before reporting them", () => {
    const state = initialRepeatedInputParserState();
    const operation = (id: string) =>
      parseCodexRepeatedInputLine(
        line({ type: "custom_tool_call", id, name: "exec", input: '{"cmd":"git status"}' }),
        state,
        { tokenizer: { countTokens: () => 7 } },
      );
    const first = operation("one");
    expect(aggregateRepeatedInputObservations(first, { rates: new Map() }).items).toEqual([]);
    const second = operation("two");
    expect(
      aggregateRepeatedInputObservations([...first, ...second], { rates: new Map() }).items,
    ).toMatchObject([{ sourceKind: "toolOperation", occurrences: 2 }]);
  });

  it("deduplicates fork/retry copies by stable operation identity", () => {
    const stateA = initialRepeatedInputParserState();
    const stateB = initialRepeatedInputParserState();
    const payload = {
      type: "custom_tool_call_output",
      id: "same-output-id",
      output: skillText,
    };
    const a = parseCodexRepeatedInputLine(line(payload), stateA, { catalog });
    const b = parseCodexRepeatedInputLine(line(payload), stateB, { catalog });
    const result = aggregateRepeatedInputObservations([...a, ...b], {
      rates: new Map(),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.occurrences).toBe(1);
  });

  it("keeps unknown model pricing unpriced instead of free", () => {
    const observation: RepeatedInputObservation = {
      sourceKind: "skill",
      displayName: "example",
      contentHash: "a".repeat(64),
      fileRevisionHash: "b".repeat(64),
      confidence: "confirmedPayload",
      observedAtMs: Date.parse("2026-09-13T00:00:00Z"),
      sessionId: "session-a",
      turnId: "turn-a",
      model: "model-without-a-rate",
      project: "project-a",
      environment: "environment-a",
      directTokens: { exact: 10, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 },
      fullSessionInputTokens: { exact: 10, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 },
      providerReportedCostUsd: null,
      dedupeKey: "observation-a",
    };
    const result = aggregateRepeatedInputObservations([observation], { rates: new Map() });
    expect(result.items[0]?.modelCosts[0]).toMatchObject({
      estimatedApiCostUsd: null,
      priceStatus: "unpriced",
    });
    expect(result.estimatedApiCostUsd).toBeNull();
    expect(result.priceStatus).toBe("unpriced");
  });

  it("retains the priced subtotal when another model is unpriced", () => {
    const base: RepeatedInputObservation = {
      sourceKind: "skill",
      displayName: "example",
      contentHash: "a".repeat(64),
      fileRevisionHash: "b".repeat(64),
      confidence: "confirmedPayload",
      observedAtMs: Date.parse("2026-09-13T00:00:00Z"),
      sessionId: "session-a",
      turnId: "turn-a",
      model: "known",
      project: "project-a",
      environment: "environment-a",
      directTokens: { exact: 10, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 },
      fullSessionInputTokens: { exact: 10, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 },
      providerReportedCostUsd: null,
      dedupeKey: "known-observation",
    };
    const result = aggregateRepeatedInputObservations(
      [
        base,
        {
          ...base,
          contentHash: "c".repeat(64),
          model: "unknown-model",
          dedupeKey: "unknown-observation",
        },
      ],
      {
        rates: parseRateTable({
          known: { input_cost_per_token: 0.01, output_cost_per_token: 0.01 },
        }),
      },
    );

    expect(result.estimatedApiCostUsd).toBeCloseTo(0.1);
    expect(result.priceStatus).toBe("unpriced");
  });

  it("uses provider-reported direct cost before model pricing", () => {
    const priced = estimateRepeatedInputCost({
      model: "known",
      directTokens: { exact: 10, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 },
      providerReportedCostUsd: 0.25,
      rates: parseRateTable({ known: { input_cost_per_token: 1, output_cost_per_token: 1 } }),
    });
    expect(priced).toMatchObject({ estimatedApiCostUsd: 0.25, priceStatus: "providerReported" });
  });
});
