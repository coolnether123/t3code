/**
 * Pure parsers for the provider CLIs' on-disk session transcripts.
 *
 * Provider parsers are line-at-a-time reducers where their formats allow it, so callers can stream large files
 * without materialising them. Neither touches the filesystem.
 *
 * @module usageTranscripts
 */
import type { UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";
import * as CodexUsage from "../provider/Drivers/codexUsage.ts";
import { CLAUDE_SYNTHETIC_MODEL } from "../provider/Drivers/claudeUsage.ts";
import { normalizeServiceTier } from "./codexServiceTier.ts";

export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly rateModel?: string;
  readonly speed?: "standard" | "fast" | "ultrafast";
  readonly sourcePath?: string;
  /** Internal aggregation/dedupe identity; may be synthetic for imported chats. */
  readonly sessionId: string;
  /** Exact provider-native run/session ID, absent when the source has none. */
  readonly nativeSessionId?: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  readonly serviceTier?: string;
  readonly serviceTierSource?: "transcript" | "t3Request" | "userReported";
  readonly turnId?: string;
  /**
   * Key for cross-file de-duplication, or `null` when the record is inherently
   * unique and needs no dedup.
   */
  readonly unresolvedServiceTierTurnId?: string;
  readonly dedupeKey: string | null;
}

const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function knownNativeSessionId(value: string): string | undefined {
  return value.length > 0 && value.length <= 512 && value.trim() === value ? value : undefined;
}

export function addTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/**
 * Cheap substring gate applied before `JSON.parse`.
 *
 * Transcripts are mostly tool output; only a minority of lines carry usage. On
 * a 30-day window this skips roughly half the lines outright and is worth about
 * an order of magnitude.
 */
export function mightCarryUsage(line: string, provider: UsageProviderKind): boolean {
  if (provider === "claude") return line.includes('"usage"');
  if (provider === "gemini") return line.includes('"tokens"');
  return line.includes('"token_count"');
}

/* Claude Code                                                                */

/**
 * Parses one line of a Claude Code transcript.
 *
 * T3 Code writes one record per assistant *content block*, and every one of
 * those records repeats the same complete `usage` object for the parent
 * message. Summing them overcounts by roughly 2.4x on a real workload, so the
 * caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0 || model === CLAUDE_SYNTHETIC_MODEL) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  // Matches ccusage: prefer the message/request pair, fall back to whichever
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];
  const sessionId = typeof record["sessionId"] === "string" ? record["sessionId"] : "";
  const nativeSessionId = knownNativeSessionId(sessionId);

  return {
    provider: "claude",
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    timestampMs,
    model,
    sessionId,
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    totals: {
      uncachedInputTokens: int(usageRecord["input_tokens"]),
      cachedInputTokens: int(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: int(usageRecord["cache_creation_input_tokens"]),
      outputTokens: int(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    dedupeKey,
  };
}

/* Gemini CLI                                                                 */

export interface GeminiScanState {
  sessionId: string;
}

export function initialGeminiScanState(): GeminiScanState {
  return { sessionId: "" };
}

/**
 * Parses Gemini CLI's session metadata and standalone message records.
 *
 * Newer sessions are JSONL streams, while older sessions store the same
 * message shape in one JSON document. The caller feeds either representation
 * through this function and keeps the last record for each message id.
 */
export function parseGeminiValue(parsed: unknown, state: GeminiScanState): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  if (typeof record["sessionId"] === "string") state.sessionId = record["sessionId"];
  if (record["type"] !== "gemini") return null;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  const model = typeof record["model"] === "string" ? record["model"] : "";
  const usage = record["tokens"];
  if (timestampMs === null || model.length === 0 || typeof usage !== "object" || usage === null) {
    return null;
  }
  const usageRecord = usage as Record<string, unknown>;
  const inputTokens = int(usageRecord["input"]);
  const cachedInputTokens = Math.min(inputTokens, int(usageRecord["cached"]));
  const thoughtTokens = int(usageRecord["thoughts"]);
  const candidateTokens = int(usageRecord["output"]);
  const toolTokens = int(usageRecord["tool"]);
  const totals: UsageTokenTotals = {
    // Gemini reports cached content as a subset of prompt tokens. Tool-use
    // prompt tokens are a separate input category and are billed as input.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens) + toolTokens,
    cachedInputTokens,
    cacheCreationTokens: 0,
    // Thoughts are billed output and included in totalTokenCount separately
    // from candidate output, so fold them into output while retaining the mix.
    outputTokens: candidateTokens + thoughtTokens,
    reasoningTokens: thoughtTokens,
  };
  if (totalTokens(totals) === 0) return null;

  const messageId = typeof record["id"] === "string" ? record["id"] : null;
  const nativeSessionId = knownNativeSessionId(state.sessionId);
  return {
    provider: "gemini",
    timestampMs,
    model,
    sessionId: state.sessionId,
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    totals,
    reportedCostUsd: null,
    dedupeKey:
      messageId === null
        ? null
        : `gemini:${state.sessionId.length > 0 ? state.sessionId : "?"}:${messageId}`,
  };
}

export function parseGeminiLine(line: string, state: GeminiScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseGeminiValue(parsed, state);
}

/** One Antigravity conversation-level token cache. */
export function parseAntigravityTokenCache(
  parsed: unknown,
  input: { readonly timestampMs: number; readonly sessionId: string },
): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const usage = parsed as Record<string, unknown>;
  const inputTokens = int(usage["input"]);
  const cachedInputTokens = Math.min(inputTokens, int(usage["cached"]));
  const outputTokens = int(usage["output"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    cachedInputTokens,
    cacheCreationTokens: 0,
    outputTokens,
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return null;
  const nativeSessionId = knownNativeSessionId(input.sessionId);
  return {
    provider: "gemini",
    timestampMs: input.timestampMs,
    model: "gemini-antigravity",
    sessionId: input.sessionId,
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    totals,
    // Antigravity's local cache reports subscription cost as zero. Usage uses
    // API-equivalent pricing, so leave this null for the normal rate lookup.
    reportedCostUsd: null,
    dedupeKey: `gemini-antigravity:${input.sessionId}`,
  };
}

/* OpenCode                                                                   */

/**
 * Parses one OpenCode assistant message from its SQLite session store.
 *
 * OpenCode 1.x stores fresh input, cache reads, cache writes, visible output,
 * and reasoning as disjoint counters. Its own `opencode stats` command adds
 * reasoning to output when computing the total, so we do the same while
 * retaining reasoning as the output subset expected by the usage contract.
 * The recorded cost is authoritative: it includes OpenCode's provider/model
 * pricing configuration, including explicit zero-cost local and free models.
 */
export function parseOpenCodeMessageValue(
  parsed: unknown,
  input: {
    readonly id: string;
    readonly sessionId: string;
    readonly timestampMs: number;
  },
): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message["role"] !== "assistant") return null;

  const providerId = typeof message["providerID"] === "string" ? message["providerID"] : "";
  const modelId = typeof message["modelID"] === "string" ? message["modelID"] : "";
  const tokens = message["tokens"];
  if (
    providerId.length === 0 ||
    modelId.length === 0 ||
    typeof tokens !== "object" ||
    tokens === null ||
    !Number.isFinite(input.timestampMs)
  ) {
    return null;
  }

  const tokenRecord = tokens as Record<string, unknown>;
  const cache = tokenRecord["cache"];
  const cacheRecord =
    typeof cache === "object" && cache !== null ? (cache as Record<string, unknown>) : {};
  const reasoningTokens = int(tokenRecord["reasoning"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: int(tokenRecord["input"]),
    cachedInputTokens: int(cacheRecord["read"]),
    cacheCreationTokens: int(cacheRecord["write"]),
    outputTokens: int(tokenRecord["output"]) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;

  const cost = message["cost"];
  const nativeSessionId = knownNativeSessionId(input.sessionId);
  return {
    provider: "opencode",
    timestampMs: input.timestampMs,
    model: `${providerId}/${modelId}`,
    sessionId: input.sessionId,
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    totals,
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    dedupeKey: input.id.length > 0 ? `opencode:${input.id}` : null,
  };
}

/* Codex                                                                      */

/**
 * Rolling state for a single Codex rollout file.
 *
 * Codex `token_count` events carry no model, so the model is carried forward
 * from the most recent `turn_context`. Sessions that switch models mid-run
 * attribute correctly from the switch onward.
 */
export interface CodexScanState {
  providerState?: CodexUsage.CodexScanState;
  model: string;
  serviceTier?: string | undefined;
  turnId?: string | undefined;
  sessionId: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  /** While true, leading usage events are re-stamped copies of parent history. */
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexScanState(): CodexScanState {
  return {
    providerState: CodexUsage.initialCodexScanState(),
    model: "",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/** Keeps native run attribution while the provider parser owns counter reconciliation. */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const envelope = parsed as Record<string, unknown>;
  const payload = envelope["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const fields = payload as Record<string, unknown>;
  const providerState = state.providerState ?? CodexUsage.initialCodexScanState();
  if (envelope["type"] === "turn_context") {
    const model = typeof fields["model"] === "string" ? fields["model"] : state.model;
    const turnId = typeof fields["turn_id"] === "string" ? fields["turn_id"] : undefined;
    // Legacy counters omit cumulative totals, so a distinct turn starts a new duplicate sequence.
    if (model !== state.model || turnId !== state.turnId) providerState.lastUsageSignature = null;
    state.serviceTier = normalizeServiceTier(fields["service_tier"] ?? fields["serviceTier"]);
    state.turnId = turnId;
  }
  const record = CodexUsage.parseCodexLine(line, providerState);
  state.providerState = providerState;
  state.model = providerState.model;
  state.sessionId = providerState.sessionId;
  state.lastUsageSignature = providerState.lastUsageSignature;
  state.sawSessionMeta = providerState.sawSessionMeta;
  state.suppressingForkCopies = providerState.suppressingForkCopies;
  state.forkCopyAnchorMs = providerState.forkCopyAnchorMs;
  if (record === null) return null;
  const info = fields["info"];
  const tier =
    normalizeServiceTier(
      (typeof info === "object" && info !== null
        ? (info as Record<string, unknown>)["service_tier"]
        : undefined) ?? fields["service_tier"],
    ) ??
    (providerState.sawThreadSettings
      ? record.speed === "fast"
        ? "priority"
        : record.speed === "ultrafast"
          ? "ultrafast"
          : "default"
      : state.serviceTier);
  const nativeSessionId = knownNativeSessionId(record.sessionId);
  return {
    ...record,
    ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    ...(tier === undefined ? {} : { serviceTier: tier, serviceTierSource: "transcript" as const }),
    dedupeKey:
      record.sessionId.length > 0
        ? `codex:${record.sessionId}:${record.timestampMs}:${JSON.stringify(record.totals)}`
        : null,
  };
}

export { EMPTY_TOTALS };
