// @effect-diagnostics nodeBuiltinImport:off - filesystem discovery uses the
// same direct Node APIs as the production importer.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  aggregateRepeatedInputObservations,
  createRepeatedInputCatalog,
  discoverCodexRepeatedInputSources,
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
  it("projects every discovered skill revision, including an unobserved one", () => {
    const unobserved = createRepeatedInputCatalog([
      { path: "C:/skills/never-used/SKILL.md", content: "never", tokenCount: 3 },
      { path: "C:/skills/observed/SKILL.md", content: "observed", tokenCount: 4 },
    ]);
    const observations = parseCodexRepeatedInputLine(
      line({ type: "custom_tool_call_output", id: "observed", output: "observed" }),
      initialRepeatedInputParserState(),
      { catalog: unobserved },
    );
    const aggregate = aggregateRepeatedInputObservations(observations, {
      rates: new Map(),
      catalog: unobserved.sources,
    });
    expect(aggregate.catalog).toHaveLength(2);
    expect(aggregate.catalog.find((item) => item.displayName === "never-used")).toMatchObject({
      observed: false,
      firstObservedAtMs: null,
      lastObservedAtMs: null,
      confidence: null,
      occurrences: 0,
      estimatedApiCostUsd: null,
    });
    expect(aggregate.catalog.find((item) => item.displayName === "observed")).toMatchObject({
      observed: true,
      confidence: "confirmedPayload",
      tokenCount: 4,
    });
  });

  it("keeps duplicate aliases as one revision while retaining path matching", () => {
    const repeated = createRepeatedInputCatalog([
      {
        path: "C:/skills/alias/SKILL.md",
        pathAliases: ["C:/junction/alias/SKILL.md"],
        content: "same revision",
        tokenCount: 2,
      },
      {
        path: "C:/junction/alias/SKILL.md",
        content: "same revision",
        tokenCount: 2,
      },
    ]);
    expect(repeated.sources).toHaveLength(1);
    expect(repeated.matchPathEvidence("read C:/junction/alias/SKILL.md")).toHaveLength(1);
  });

  it("reports missing discovery roots instead of returning a complete-looking catalog", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-repeated-input-"));
    try {
      const result = await discoverCodexRepeatedInputSources({
        roots: [NodePath.join(root, "missing"), NodePath.join(root, "missing")],
      });
      expect(result.sources).toEqual([]);
      expect(result.gaps).toEqual([
        { reason: "unavailable", path: NodePath.join(root, "missing") },
      ]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!symlinksSupported)(
    "retains junction aliases while deduplicating the same discovered revision",
    async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-repeated-input-link-"));
      const target = NodePath.join(root, "target");
      const alias = NodePath.join(root, "alias");
      const skillDirectory = NodePath.join(target, "linked-skill");
      const skill = NodePath.join(skillDirectory, "SKILL.md");
      try {
        await NodeFSP.mkdir(skillDirectory, { recursive: true });
        await NodeFSP.writeFile(skill, "linked revision");
        // Node ignores the junction hint on non-Windows platforms.
        await NodeFSP.symlink(target, alias, "junction");
        const result = await discoverCodexRepeatedInputSources({
          roots: [target, alias],
          tokenizer: { countTokens: () => 2 },
        });
        expect(result.sources).toHaveLength(1);
        expect(result.catalog.matchPathEvidence(`${alias}/linked-skill/SKILL.md`)).toHaveLength(1);
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );

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

  it("carries a loaded skill into later cached turns with payload-sized attribution", () => {
    const state = initialRepeatedInputParserState();
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-09-13T00:59:00Z",
        payload: { id: "session-carried" },
      }),
      state,
    );
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-09-13T00:59:01Z",
        payload: { turn_id: "turn-load", model: "gpt-5.6-sol" },
      }),
      state,
    );
    const loaded = parseCodexRepeatedInputLine(
      line({ type: "custom_tool_call_output", id: "load", output: skillText }),
      state,
      { catalog },
    );
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-09-13T01:00:00Z",
        payload: { turn_id: "turn-cache-write", model: "gpt-5.6-sol" },
      }),
      state,
    );
    const cacheWrite = parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-13T01:00:01Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 17,
              cached_input_tokens: 0,
              cache_write_input_tokens: 17,
              output_tokens: 5,
            },
          },
        },
      }),
      state,
      { catalog },
    );
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-09-13T01:01:00Z",
        payload: { turn_id: "turn-later", model: "gpt-5.6-sol" },
      }),
      state,
    );
    const later = parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-13T01:01:01Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 17,
              cached_input_tokens: 17,
              cache_write_input_tokens: 0,
              output_tokens: 5,
            },
          },
        },
      }),
      state,
      { catalog },
    );
    expect(loaded[0]?.directTokens).toMatchObject({ exact: 17 });
    expect(cacheWrite[0]).toMatchObject({
      confidence: "confirmedPayload",
      directTokens: { exact: 0, cached: 0, cacheWrite: 17, unknown: 0 },
    });
    expect(later[0]).toMatchObject({
      turnId: "turn-later",
      confidence: "confirmedPayload",
      directTokens: { exact: 0, cached: 17, cacheWrite: 0, unknown: 0 },
    });
    const carriedAggregate = aggregateRepeatedInputObservations(
      [...loaded, ...cacheWrite, ...later],
      { rates: new Map() },
    );
    expect(carriedAggregate.items[0]).toMatchObject({
      occurrences: 3,
      directTokens: { cacheWrite: 17, cached: 17, unknown: 0 },
    });
  });

  it("does not borrow an unrelated prior cache write for a later skill load", () => {
    const state = initialRepeatedInputParserState();
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-09-13T00:59:00Z",
        payload: { id: "session-unrelated-cache" },
      }),
      state,
    );
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-09-13T00:59:01Z",
        payload: { turn_id: "turn-load", model: "gpt-5.6-sol" },
      }),
      state,
    );
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-13T00:59:02Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 0,
              cache_write_input_tokens: 500,
              output_tokens: 1,
            },
          },
        },
      }),
      state,
      { catalog },
    );
    const loaded = parseCodexRepeatedInputLine(
      line({ type: "custom_tool_call_output", id: "load-after-cache", output: skillText }),
      state,
      { catalog },
    );
    expect(loaded[0]?.directTokens).toMatchObject({ exact: 17, cacheWrite: 0 });
    expect(state.activeSources?.[0]?.loadedTurnId).toBe("turn-load");
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-09-13T01:00:00Z",
        payload: { turn_id: "turn-later", model: "gpt-5.6-sol" },
      }),
      state,
    );
    const later = parseCodexRepeatedInputLineDetailed(
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-13T01:00:01Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 17,
              cache_write_input_tokens: 0,
              output_tokens: 1,
            },
          },
        },
      }),
      state,
      { catalog },
    );
    expect(later.observations[0]?.directTokens).toMatchObject({ unknown: 17, cached: 0 });
  });

  it("keeps carried skill tokens unknown when cache-prefix evidence is insufficient", () => {
    const state = initialRepeatedInputParserState();
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-09-13T00:59:00Z",
        payload: { id: "session-unknown" },
      }),
      state,
    );
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-09-13T00:59:01Z",
        payload: { turn_id: "turn-load", model: "gpt-5.6-sol" },
      }),
      state,
    );
    parseCodexRepeatedInputLine(
      line({ type: "custom_tool_call_output", id: "load", output: skillText }),
      state,
      { catalog },
    );
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-09-13T01:01:00Z",
        payload: { turn_id: "turn-later", model: "gpt-5.6-sol" },
      }),
      state,
    );
    const carried = parseCodexRepeatedInputLineDetailed(
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-13T01:01:01Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 17,
              cache_write_input_tokens: 0,
              output_tokens: 5,
            },
          },
        },
      }),
      state,
      { catalog },
    );
    expect(carried.observations[0]).toMatchObject({
      confidence: "likelyRead",
      directTokens: { exact: 0, estimated: 0, cached: 0, cacheWrite: 0, unknown: 17 },
    });
    expect(carried.gaps).toEqual([expect.objectContaining({ reason: "unattributed", count: 17 })]);
  });

  it("deduplicates repeated token-count events and stops carrying after compaction", () => {
    const state = initialRepeatedInputParserState();
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-09-13T00:59:00Z",
        payload: { id: "session-boundary" },
      }),
      state,
    );
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-09-13T00:59:01Z",
        payload: { turn_id: "turn-load", model: "gpt-5.6-sol" },
      }),
      state,
    );
    parseCodexRepeatedInputLine(
      line({ type: "custom_tool_call_output", id: "load", output: skillText }),
      state,
      { catalog },
    );
    const tokenCount = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-09-13T01:00:00Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 17,
            cached_input_tokens: 0,
            cache_write_input_tokens: 17,
            output_tokens: 5,
          },
        },
      },
    });
    expect(parseCodexRepeatedInputLine(tokenCount, state, { catalog })).toHaveLength(1);
    expect(parseCodexRepeatedInputLine(tokenCount, state, { catalog })).toEqual([]);
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-09-13T01:00:01Z",
        payload: { type: "compaction" },
      }),
      state,
      { catalog },
    );
    parseCodexRepeatedInputLine(
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-09-13T01:01:00Z",
        payload: { turn_id: "turn-after-compaction", model: "gpt-5.6-sol" },
      }),
      state,
    );
    expect(parseCodexRepeatedInputLine(tokenCount, state, { catalog })).toEqual([]);
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

  it("keeps historical observations for changed skill revisions separate", () => {
    const revisions = createRepeatedInputCatalog([
      { path: "C:/cache/v1/skills/revision/SKILL.md", content: "revision one", tokenCount: 2 },
      { path: "C:/cache/v2/skills/revision/SKILL.md", content: "revision two", tokenCount: 2 },
    ]);
    const first = parseCodexRepeatedInputLine(
      line({ type: "custom_tool_call_output", id: "v1", output: "revision one" }),
      initialRepeatedInputParserState(),
      { catalog: revisions },
    );
    const second = parseCodexRepeatedInputLine(
      line({ type: "custom_tool_call_output", id: "v2", output: "revision two" }),
      initialRepeatedInputParserState(),
      { catalog: revisions },
    );
    const aggregate = aggregateRepeatedInputObservations([...first, ...second], {
      rates: new Map(),
      catalog: revisions.sources,
    });
    expect(aggregate.items).toHaveLength(2);
    expect(new Set(aggregate.items.map((item) => item.fileRevisionHash)).size).toBe(2);
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

  it("prices cached and cache-write input with the selected model's rates", () => {
    const rates = parseRateTable({
      "model-a": {
        input_cost_per_token: 1,
        output_cost_per_token: 1,
        cache_read_input_token_cost: 0.1,
        cache_creation_input_token_cost: 2,
      },
      "model-b": {
        input_cost_per_token: 3,
        output_cost_per_token: 1,
        cache_read_input_token_cost: 0.25,
        cache_creation_input_token_cost: 4,
      },
    });
    const directTokens = { exact: 2, estimated: 0, cached: 3, cacheWrite: 5, unknown: 0 };

    expect(
      estimateRepeatedInputCost({
        model: "model-a",
        directTokens,
        providerReportedCostUsd: null,
        rates,
      }),
    ).toMatchObject({ estimatedApiCostUsd: 12.3, priceStatus: "estimated" });
    expect(
      estimateRepeatedInputCost({
        model: "model-b",
        directTokens,
        providerReportedCostUsd: null,
        rates,
      }),
    ).toMatchObject({ estimatedApiCostUsd: 26.75, priceStatus: "estimated" });
  });
});
