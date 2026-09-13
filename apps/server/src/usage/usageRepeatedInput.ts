// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Detection and attribution for reusable input carried by Codex transcripts.
 *
 * This module deliberately keeps source text in short-lived matcher closures.
 * Observations contain hashes, names, counts, and provenance only. They are
 * safe to put in the transcript cache or a Usage response.
 */
import * as NodeChildProcess from "node:child_process";
import type { Dirent } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createHash } from "node:crypto";

import type {
  UsageRepeatedInputConfidence,
  UsageRepeatedInputCoverageGap,
  UsageRepeatedInputPriceStatus,
  UsageRepeatedInputSourceKind,
  UsageRepeatedInputTokenAttribution,
  UsageTokenTotals,
} from "@t3tools/contracts";

import { priceUsage, type RateTable } from "./usagePricing.ts";

const DEFAULT_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const FORK_COPY_MAX_GAP_MS = 1000;
/** Bump when cached observation semantics change, without discarding ordinary Usage records. */
export const REPEATED_INPUT_CACHE_VERSION = 1 as const;

export interface RepeatedInputTokenizer {
  readonly countTokens: (content: string) => number | null;
  readonly countTokensBatch?: (contents: readonly string[]) => readonly (number | null)[];
}

/**
 * Optional local tokenizer adapter. It does no work unless the caller uses it.
 * A missing Python/tiktoken installation returns `null`, which becomes a
 * visible coverage gap rather than a guessed token count.
 */
export function createPythonTiktokenTokenizer(
  options: {
    readonly pythonCommands?: readonly string[] | undefined;
    readonly encoding?: string | undefined;
    readonly timeoutMs?: number | undefined;
  } = {},
): RepeatedInputTokenizer {
  const commands = options.pythonCommands ?? ["python", "python3"];
  const encoding = options.encoding ?? "o200k_base";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const script = [
    "import json",
    "import sys",
    "try:",
    "    import tiktoken",
    `    enc=tiktoken.get_encoding(${JSON.stringify(encoding)})`,
    "    values=json.load(sys.stdin)",
    "    print(json.dumps([len(enc.encode(value)) for value in values]))",
    "except Exception:",
    "    sys.exit(3)",
  ].join("\n");

  const countTokensBatch = (contents: readonly string[]): readonly (number | null)[] => {
    if (contents.length === 0) return [];
    for (const command of commands) {
      const result = NodeChildProcess.spawnSync(command, ["-c", script], {
        input: JSON.stringify(contents),
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      if (result.error || result.status !== 0) continue;
      try {
        const values = JSON.parse(result.stdout) as unknown;
        if (
          Array.isArray(values) &&
          values.length === contents.length &&
          values.every((value) => Number.isSafeInteger(value) && value >= 0)
        ) {
          return values as number[];
        }
      } catch {
        // Try the next configured local Python command.
      }
    }
    return contents.map(() => null);
  };

  return {
    countTokens: (content) => countTokensBatch([content])[0] ?? null,
    countTokensBatch,
  };
}

export interface RepeatedInputTokenAttribution {
  readonly exact: number;
  readonly estimated: number;
  readonly cached: number;
  readonly cacheWrite: number;
  readonly unknown: number;
}

export const EMPTY_REPEATED_INPUT_TOKENS: RepeatedInputTokenAttribution = {
  exact: 0,
  estimated: 0,
  cached: 0,
  cacheWrite: 0,
  unknown: 0,
};

export interface RepeatedInputSourceDescriptor {
  readonly sourceKind: UsageRepeatedInputSourceKind;
  readonly displayName: string;
  readonly contentHash: string;
  readonly fileRevisionHash: string | null;
  readonly byteLength: number | null;
  readonly tokenCount: number | null;
}

interface CatalogEntry extends RepeatedInputSourceDescriptor {
  readonly normalizedPath: string | null;
  readonly content: string;
}

export interface RepeatedInputCatalog {
  /** Descriptors are safe to persist. They never contain source text. */
  readonly sources: readonly RepeatedInputSourceDescriptor[];
  readonly matchExactText: (text: string) => readonly RepeatedInputSourceDescriptor[];
  readonly matchPathEvidence: (text: string) => readonly RepeatedInputSourceDescriptor[];
  /** Number of name-only references that match more than one content revision. */
  readonly ambiguousPathEvidence: (text: string) => number;
}

export interface RepeatedInputCatalogEntryInput {
  readonly path?: string;
  readonly content: string;
  readonly sourceKind?: UsageRepeatedInputSourceKind;
  readonly displayName?: string;
  readonly fileRevisionHash?: string | null;
  readonly tokenCount?: number | null;
}

/** SHA-256 of exact UTF-8 content, used for stable item identity. */
export function stableContentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Alias used by importers that do not need to distinguish content from a file. */
export const hashRepeatedInput = stableContentHash;

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replaceAll(/\/+/g, "/").toLowerCase();
}

function basename(value: string): string {
  const normalized = normalizePath(value).replace(/\/$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

function derivedDisplayName(
  path: string | undefined,
  sourceKind: UsageRepeatedInputSourceKind,
): string {
  if (path === undefined || path.length === 0) {
    return sourceKind === "skill" ? "Skill" : sourceKind;
  }
  const normalized = normalizePath(path);
  const file = basename(normalized);
  if (sourceKind === "skill" && file === "skill.md") {
    const parent = normalized.slice(0, normalized.lastIndexOf("/"));
    const parentName = basename(parent);
    return parentName.length > 0 ? parentName : file;
  }
  return file.length > 0 ? file : sourceKind;
}

function sourceKindForPath(path: string): UsageRepeatedInputSourceKind | null {
  const file = basename(path);
  if (file === "skill.md") return "skill";
  if (
    file === "agents.md" ||
    file === "claude.md" ||
    file === "instructions.md" ||
    file === "instruction.md"
  ) {
    return "instruction";
  }
  return null;
}

function asNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function sanitizeTokenCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Builds a matcher catalog while retaining source text only in a closure. */
export function createRepeatedInputCatalog(
  entries: readonly RepeatedInputCatalogEntryInput[],
  options: { readonly tokenizer?: RepeatedInputTokenizer | undefined } = {},
): RepeatedInputCatalog {
  const catalog: CatalogEntry[] = [];
  for (const input of entries) {
    const path = input.path;
    const sourceKind = input.sourceKind ?? (path === undefined ? null : sourceKindForPath(path));
    if (sourceKind === null || input.content.length === 0) continue;
    const contentHash = stableContentHash(input.content);
    const tokenCount =
      sanitizeTokenCount(input.tokenCount) ?? options.tokenizer?.countTokens(input.content) ?? null;
    const fileRevisionHash =
      input.fileRevisionHash === undefined
        ? path === undefined
          ? null
          : contentHash
        : input.fileRevisionHash;
    catalog.push({
      sourceKind,
      displayName: input.displayName ?? derivedDisplayName(path, sourceKind),
      contentHash,
      fileRevisionHash,
      byteLength: Buffer.byteLength(input.content, "utf8"),
      tokenCount,
      normalizedPath: path === undefined ? null : normalizePath(path),
      content: input.content,
    });
  }

  const descriptors = catalog.map(({ content: _content, normalizedPath: _path, ...descriptor }) =>
    Object.freeze(descriptor),
  );
  const uniqueMatches = (
    matches: readonly CatalogEntry[],
  ): readonly RepeatedInputSourceDescriptor[] => {
    const seen = new Set<string>();
    const result: RepeatedInputSourceDescriptor[] = [];
    for (const entry of matches) {
      const key = `${entry.sourceKind}\u0000${entry.contentHash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { content: _content, normalizedPath: _path, ...descriptor } = entry;
      result.push(descriptor);
    }
    return result;
  };

  const pathEvidence = (text: string) => {
    const normalizedText = normalizePath(text);
    const pathMatches = catalog.filter(
      (entry) => entry.normalizedPath !== null && normalizedText.includes(entry.normalizedPath),
    );
    if (pathMatches.length > 0) {
      return { matches: uniqueMatches(pathMatches), ambiguous: 0 };
    }

    const byName = new Map<string, CatalogEntry[]>();
    for (const entry of catalog) {
      const nameMatch =
        normalizedText.includes(entry.displayName.toLowerCase()) &&
        (entry.sourceKind !== "skill" ||
          normalizedText.includes("skill") ||
          normalizedText.includes("mandatory") ||
          normalizedText.includes("load") ||
          normalizedText.includes("catalog"));
      if (!nameMatch) continue;
      const key = `${entry.sourceKind}\u0000${entry.displayName.toLowerCase()}`;
      const group = byName.get(key);
      if (group === undefined) byName.set(key, [entry]);
      else group.push(entry);
    }

    const matches: CatalogEntry[] = [];
    let ambiguous = 0;
    for (const candidates of byName.values()) {
      const revisions = new Set(candidates.map((entry) => entry.contentHash));
      if (revisions.size === 1) matches.push(candidates[0]!);
      else ambiguous += 1;
    }
    return { matches: uniqueMatches(matches), ambiguous };
  };

  return {
    sources: descriptors,
    matchExactText: (text) =>
      uniqueMatches(catalog.filter((entry) => text.includes(entry.content))),
    matchPathEvidence: (text) => pathEvidence(text).matches,
    ambiguousPathEvidence: (text) => pathEvidence(text).ambiguous,
  };
}

export interface RepeatedInputDiscoveryGap {
  readonly reason: "oversized" | "unavailable" | "missingTokenizer";
  readonly path: string;
}

export interface RepeatedInputDiscoveryResult {
  readonly catalog: RepeatedInputCatalog;
  readonly sources: readonly RepeatedInputSourceDescriptor[];
  readonly gaps: readonly RepeatedInputDiscoveryGap[];
}

export interface RepeatedInputDiscoveryOptions {
  readonly roots?: readonly string[] | undefined;
  readonly maxSourceBytes?: number | undefined;
  readonly tokenizer?: RepeatedInputTokenizer | undefined;
}

/** Default Codex skill/plugin locations. Callers can supply extra roots. */
export function defaultCodexInputRoots(home = NodeOS.homedir()): readonly string[] {
  const codexHome = process.env.CODEX_HOME?.trim() || NodePath.join(home, ".codex");
  return [
    NodePath.join(codexHome, "skills"),
    NodePath.join(codexHome, "plugins"),
    NodePath.join(home, ".codex", "skills"),
    NodePath.join(home, ".codex", "plugins"),
  ];
}

async function findInputFiles(root: string, result: string[], seen: Set<string>): Promise<void> {
  let entries: readonly Dirent[];
  try {
    entries = await NodeFS.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = NodePath.join(root, entry.name);
    if (entry.isDirectory()) {
      await findInputFiles(path, result, seen);
      continue;
    }
    if (!entry.isFile()) continue;
    const kind = sourceKindForPath(path);
    if (kind === null) continue;
    const normalized = normalizePath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(path);
  }
}

/** Discovers skill/instruction files without embedding their text in output. */
export async function discoverCodexRepeatedInputSources(
  options: RepeatedInputDiscoveryOptions = {},
): Promise<RepeatedInputDiscoveryResult> {
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const paths: string[] = [];
  const seen = new Set<string>();
  const gaps: RepeatedInputDiscoveryGap[] = [];
  for (const root of options.roots ?? defaultCodexInputRoots()) {
    try {
      const stat = await NodeFS.stat(root);
      if (!stat.isDirectory()) {
        gaps.push({ reason: "unavailable", path: root });
        continue;
      }
    } catch {
      gaps.push({ reason: "unavailable", path: root });
      continue;
    }
    await findInputFiles(root, paths, seen);
  }

  const entries: RepeatedInputCatalogEntryInput[] = [];
  for (const path of paths) {
    try {
      const stat = await NodeFS.stat(path);
      if (stat.size > maxSourceBytes) {
        gaps.push({ reason: "oversized", path });
        continue;
      }
      const content = await NodeFS.readFile(path, "utf8");
      entries.push({
        path,
        content,
        fileRevisionHash: stableContentHash(content),
      });
    } catch {
      gaps.push({ reason: "unavailable", path });
    }
  }
  const tokenCounts =
    options.tokenizer === undefined
      ? entries.map(() => null)
      : (options.tokenizer.countTokensBatch?.(entries.map((entry) => entry.content)) ??
        entries.map((entry) => options.tokenizer?.countTokens(entry.content) ?? null));
  const entriesWithTokens = entries.map((entry, index) => {
    const tokenCount = tokenCounts[index] ?? null;
    if (options.tokenizer !== undefined && tokenCount === null) {
      gaps.push({ reason: "missingTokenizer", path: entry.path ?? "" });
    }
    return { ...entry, tokenCount };
  });
  const catalog = createRepeatedInputCatalog(entriesWithTokens);
  return { catalog, sources: catalog.sources, gaps };
}

export interface RepeatedInputParserState {
  sessionId: string;
  model: string;
  turnId: string | undefined;
  project: string | null;
  environment: string | null;
  lastInputTokens: UsageTokenTotals | null;
  lastTimestampMs: number;
  ordinal: number;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialRepeatedInputParserState(
  options: { readonly project?: string | null; readonly environment?: string | null } = {},
): RepeatedInputParserState {
  return {
    sessionId: "",
    model: "",
    turnId: undefined,
    project: options.project ?? null,
    environment: options.environment ?? null,
    lastInputTokens: null,
    lastTimestampMs: 0,
    ordinal: 0,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

export interface RepeatedInputObservation {
  readonly sourceKind: UsageRepeatedInputSourceKind;
  readonly displayName: string;
  readonly contentHash: string;
  readonly fileRevisionHash: string | null;
  readonly confidence: UsageRepeatedInputConfidence;
  readonly observedAtMs: number;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly model: string | null;
  readonly project: string | null;
  readonly environment: string | null;
  readonly directTokens: RepeatedInputTokenAttribution;
  readonly fullSessionInputTokens: RepeatedInputTokenAttribution;
  readonly providerReportedCostUsd: number | null;
  readonly dedupeKey: string;
}

export interface RepeatedInputParseResult {
  readonly observations: readonly RepeatedInputObservation[];
  readonly gaps: readonly UsageRepeatedInputCoverageGap[];
}

export interface ParseCodexRepeatedInputOptions {
  readonly catalog?: RepeatedInputCatalog | undefined;
  readonly tokenizer?: RepeatedInputTokenizer | undefined;
  readonly maxPayloadBytes?: number | undefined;
  readonly project?: string | null | undefined;
  readonly environment?: string | null | undefined;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function textValues(value: unknown, output: string[] = []): readonly string[] {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value) textValues(child, output);
    return output;
  }
  const object = recordObject(value);
  if (object === null) return output;
  for (const [key, child] of Object.entries(object)) {
    if (key === "text" || key === "output" || key === "content" || key === "stdout") {
      textValues(child, output);
    }
  }
  return output;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseUsage(value: unknown): UsageTokenTotals | null {
  const object = recordObject(value);
  if (object === null) return null;
  const input = asNonNegativeInt(object["input_tokens"]);
  const cached = asNonNegativeInt(object["cached_input_tokens"]);
  const cacheWrite = asNonNegativeInt(object["cache_write_input_tokens"]);
  const output = asNonNegativeInt(object["output_tokens"]);
  const reasoning = Math.min(output, asNonNegativeInt(object["reasoning_output_tokens"]));
  if (input === 0 && cached === 0 && cacheWrite === 0 && output === 0) return null;
  return {
    uncachedInputTokens: Math.max(0, input - cached - cacheWrite),
    cachedInputTokens: cached,
    cacheCreationTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
  };
}

function fullSessionTokens(usage: UsageTokenTotals | null): RepeatedInputTokenAttribution {
  if (usage === null) return EMPTY_REPEATED_INPUT_TOKENS;
  return {
    exact: usage.uncachedInputTokens,
    estimated: 0,
    cached: usage.cachedInputTokens,
    cacheWrite: usage.cacheCreationTokens,
    unknown: 0,
  };
}

function directTokens(
  descriptor: RepeatedInputSourceDescriptor,
  confidence: UsageRepeatedInputConfidence,
): RepeatedInputTokenAttribution {
  if (confidence === "reference") return EMPTY_REPEATED_INPUT_TOKENS;
  // The descriptor is intentionally text-free. If discovery did not obtain a
  // count, the caller must surface a tokenizer gap rather than tokenizing an
  // empty placeholder or guessing from byte length.
  const tokenCount = descriptor.tokenCount ?? null;
  if (tokenCount === null) return EMPTY_REPEATED_INPUT_TOKENS;
  // Codex reports cache classes for the complete request, not for a specific
  // payload inside it. Assigning those totals to this item would invent
  // precision. The matched request's cache split is retained separately in
  // fullSessionInputTokens.
  return confidence === "confirmedPayload"
    ? { exact: tokenCount, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 }
    : { exact: 0, estimated: tokenCount, cached: 0, cacheWrite: 0, unknown: 0 };
}

function confidenceRank(confidence: UsageRepeatedInputConfidence): number {
  return confidence === "confirmedPayload" ? 3 : confidence === "likelyRead" ? 2 : 1;
}

function looksLikeReadCommand(text: string): boolean {
  return /(?:cat|type|head|tail|sed|awk|Get-Content|read(?:file)?|open|load|include)/i.test(text);
}

function explicitReference(text: string): boolean {
  return /(?:skill|instruction|mandatory|catalog|developer\s+block|SKILL\.md|AGENTS\.md)/i.test(
    text,
  );
}

function sourceFromNamedBlock(
  value: Record<string, unknown>,
  tokenizer: RepeatedInputTokenizer | undefined,
): RepeatedInputSourceDescriptor | null {
  const name =
    typeof value["name"] === "string"
      ? value["name"]
      : typeof value["block_name"] === "string"
        ? value["block_name"]
        : typeof value["blockName"] === "string"
          ? value["blockName"]
          : null;
  const contentValue = value["text"] ?? value["content"] ?? value["value"];
  if (name === null || typeof contentValue !== "string" || contentValue.length === 0) return null;
  const contentHash = stableContentHash(contentValue);
  return {
    sourceKind: "developerBlock",
    displayName: name.trim().length > 0 ? name.trim() : "Developer block",
    contentHash,
    fileRevisionHash: null,
    byteLength: Buffer.byteLength(contentValue, "utf8"),
    tokenCount: tokenizer?.countTokens(contentValue) ?? null,
  };
}

function instructionSourcesFromText(
  text: string,
  tokenizer: RepeatedInputTokenizer | undefined,
): readonly RepeatedInputSourceDescriptor[] {
  const sources: RepeatedInputSourceDescriptor[] = [];
  const pattern =
    /#\s+AGENTS\.md instructions for [^\r\n]+\r?\n<INSTRUCTIONS>\r?\n([\s\S]*?)\r?\n<\/INSTRUCTIONS>/gi;
  for (const match of text.matchAll(pattern)) {
    const content = match[1];
    if (content === undefined || content.length === 0) continue;
    const contentHash = stableContentHash(content);
    sources.push({
      sourceKind: "instruction",
      displayName: "AGENTS.md",
      contentHash,
      fileRevisionHash: contentHash,
      byteLength: Buffer.byteLength(content, "utf8"),
      tokenCount: tokenizer?.countTokens(content) ?? null,
    });
  }
  return sources;
}

function operationSource(
  payload: Record<string, unknown>,
  tokenizer: RepeatedInputTokenizer | undefined,
): RepeatedInputSourceDescriptor | null {
  if (payload["type"] !== "function_call" && payload["type"] !== "custom_tool_call") return null;
  const name = typeof payload["name"] === "string" ? payload["name"].trim() : "";
  if (name.length === 0) return null;
  const input = payload["arguments"] ?? payload["input"] ?? payload["parameters"];
  if (input === undefined) return null;
  const canonical = canonicalJson({ name, input: parseJsonValue(input) });
  return {
    sourceKind: "toolOperation",
    displayName: name,
    contentHash: stableContentHash(canonical),
    fileRevisionHash: null,
    byteLength: Buffer.byteLength(canonical, "utf8"),
    tokenCount: tokenizer?.countTokens(canonical) ?? null,
  };
}

function observation(
  descriptor: RepeatedInputSourceDescriptor,
  confidence: UsageRepeatedInputConfidence,
  state: RepeatedInputParserState,
  timestampMs: number,
  identity: string,
  providerReportedCostUsd: number | null = null,
): RepeatedInputObservation {
  const sessionId = state.sessionId;
  const turnId = state.turnId ?? null;
  const evidenceIdentity =
    descriptor.sourceKind === "skill" || descriptor.sourceKind === "instruction"
      ? confidence === "reference"
        ? `reference:${sessionId || identity}`
        : `load:${sessionId}:${turnId ?? identity}`
      : identity;
  const dedupeKey = [
    "codex-repeated-input",
    evidenceIdentity,
    descriptor.sourceKind,
    descriptor.contentHash,
  ].join(":");
  return {
    sourceKind: descriptor.sourceKind,
    displayName: descriptor.displayName,
    contentHash: descriptor.contentHash,
    fileRevisionHash: descriptor.fileRevisionHash,
    confidence,
    observedAtMs: timestampMs,
    sessionId,
    turnId,
    model: state.model.length > 0 ? state.model : null,
    project: state.project,
    environment: state.environment,
    directTokens: directTokens(descriptor, confidence),
    fullSessionInputTokens: fullSessionTokens(state.lastInputTokens),
    providerReportedCostUsd,
    dedupeKey,
  };
}

function addBestObservation(
  byKey: Map<string, RepeatedInputObservation>,
  next: RepeatedInputObservation,
): void {
  const previous = byKey.get(next.dedupeKey);
  if (
    previous === undefined ||
    confidenceRank(next.confidence) > confidenceRank(previous.confidence)
  ) {
    byKey.set(next.dedupeKey, next);
  }
}

function updateState(record: Record<string, unknown>, state: RepeatedInputParserState): void {
  const timestampMs = parseTimestamp(record["timestamp"]);
  if (timestampMs !== null) state.lastTimestampMs = timestampMs;
  const payload = recordObject(record["payload"]);
  if (payload === null) return;
  if (record["type"] === "session_meta") {
    const id = payload["session_id"] ?? payload["sessionId"] ?? payload["id"];
    if (typeof id === "string") state.sessionId = id;
    const cwd = payload["cwd"] ?? payload["project"];
    if (typeof cwd === "string" && state.project === null) state.project = cwd;
    const model = payload["model"];
    if (typeof model === "string") state.model = model;
    const source = recordObject(payload["source"]);
    const subagent = source === null ? null : recordObject(source["subagent"]);
    const spawn = subagent === null ? null : recordObject(subagent["thread_spawn"]);
    const forkedFrom = payload["forked_from_id"] ?? payload["forkedFromId"];
    const isForked =
      typeof forkedFrom === "string" ||
      (spawn !== null && typeof spawn["parent_thread_id"] === "string");
    if (isForked && timestampMs !== null) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = timestampMs;
    }
  } else if (record["type"] === "turn_context") {
    const model = payload["model"];
    if (typeof model === "string") state.model = model;
    const turnId = payload["turn_id"] ?? payload["turnId"];
    const nextTurnId = typeof turnId === "string" ? turnId : undefined;
    if (nextTurnId !== state.turnId) state.lastInputTokens = null;
    state.turnId = nextTurnId;
    const cwd = payload["cwd"] ?? payload["project"];
    if (typeof cwd === "string" && state.project === null) state.project = cwd;
  } else if (payload["type"] === "token_count") {
    const info = recordObject(payload["info"]);
    const usage = info === null ? null : parseUsage(info["last_token_usage"]);
    if (usage !== null) state.lastInputTokens = usage;
  }
}

function detailedParseCodexRepeatedInputLine(
  line: string,
  state: RepeatedInputParserState,
  options: ParseCodexRepeatedInputOptions,
): RepeatedInputParseResult {
  state.ordinal += 1;
  if (
    options.maxPayloadBytes !== undefined &&
    Buffer.byteLength(line, "utf8") > options.maxPayloadBytes
  ) {
    return {
      observations: [],
      gaps: [
        {
          reason: "oversized",
          count: 1,
          message: "A Codex transcript record exceeded the repeated-input size limit.",
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return {
      observations: [],
      gaps: [
        { reason: "malformed", count: 1, message: "A Codex transcript record was malformed." },
      ],
    };
  }
  const record = recordObject(parsed);
  if (record === null) {
    return {
      observations: [],
      gaps: [
        { reason: "malformed", count: 1, message: "A Codex transcript record was not an object." },
      ],
    };
  }
  const timestampMs = parseTimestamp(record["timestamp"]) ?? state.lastTimestampMs;
  const previousSession = state.sessionId;
  updateState(record, state);
  if (options.project !== undefined && options.project !== null) state.project = options.project;
  if (options.environment !== undefined && options.environment !== null) {
    state.environment = options.environment;
  }
  if (state.suppressingForkCopies && timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
    state.forkCopyAnchorMs = timestampMs;
    return { observations: [], gaps: [] };
  }
  state.suppressingForkCopies = false;
  const payload = recordObject(record["payload"]);
  if (payload === null || record["type"] !== "response_item") {
    return { observations: [], gaps: [] };
  }

  const byKey = new Map<string, RepeatedInputObservation>();
  const gaps: UsageRepeatedInputCoverageGap[] = [];
  const catalog = options.catalog;
  const payloadType = typeof payload["type"] === "string" ? payload["type"] : "";
  const rawReportedCost =
    payload["costUSD"] ??
    payload["costUsd"] ??
    payload["cost_usd"] ??
    record["costUSD"] ??
    record["costUsd"];
  const providerReportedCostUsd =
    typeof rawReportedCost === "number" && Number.isFinite(rawReportedCost) && rawReportedCost >= 0
      ? rawReportedCost
      : null;
  const payloadId =
    typeof payload["id"] === "string"
      ? payload["id"]
      : typeof payload["call_id"] === "string"
        ? payload["call_id"]
        : `${state.sessionId}:${state.turnId ?? ""}:${timestampMs}:${state.ordinal}`;
  const currentState = { ...state };
  if (previousSession.length > 0 && previousSession !== state.sessionId) {
    currentState.sessionId = state.sessionId;
  }

  const addCatalogMatches = (
    matches: readonly RepeatedInputSourceDescriptor[],
    confidence: UsageRepeatedInputConfidence,
    identitySuffix: string,
  ) => {
    for (const descriptor of matches) {
      addBestObservation(
        byKey,
        observation(
          descriptor,
          confidence,
          currentState,
          timestampMs,
          `${payloadId}:${identitySuffix}`,
          providerReportedCostUsd,
        ),
      );
    }
  };

  if (
    payloadType === "function_call_output" ||
    payloadType === "custom_tool_call_output" ||
    payloadType === "tool_output"
  ) {
    for (const text of textValues(payload["output"] ?? payload["content"])) {
      addCatalogMatches(catalog?.matchExactText(text) ?? [], "confirmedPayload", "output");
    }
  }

  if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    const input = payload["arguments"] ?? payload["input"] ?? payload["parameters"];
    const inputText = typeof input === "string" ? input : canonicalJson(input);
    if (catalog !== undefined && looksLikeReadCommand(inputText)) {
      addCatalogMatches(catalog.matchPathEvidence(inputText), "likelyRead", "read");
      const ambiguous = catalog.ambiguousPathEvidence(inputText);
      if (ambiguous > 0) {
        gaps.push({
          reason: "unattributed",
          count: ambiguous,
          message: "A reusable input name matched multiple file revisions without an exact path.",
        });
      }
    }
    const operation = operationSource(payload, options.tokenizer);
    if (operation !== null) {
      addBestObservation(
        byKey,
        observation(
          operation,
          "confirmedPayload",
          currentState,
          timestampMs,
          `${payloadId}:operation`,
          providerReportedCostUsd,
        ),
      );
    }
  }

  const namedBlock = sourceFromNamedBlock(payload, options.tokenizer);
  if (namedBlock !== null) {
    addBestObservation(
      byKey,
      observation(
        namedBlock,
        "confirmedPayload",
        currentState,
        timestampMs,
        `${payloadId}:developer-block`,
        providerReportedCostUsd,
      ),
    );
  }

  if (payloadType === "message" || payloadType === "developer_message") {
    const role = typeof payload["role"] === "string" ? payload["role"] : "";
    if (role === "developer" || role === "system" || role === "user") {
      for (const text of textValues(payload["content"])) {
        for (const descriptor of instructionSourcesFromText(text, options.tokenizer)) {
          addBestObservation(
            byKey,
            observation(
              descriptor,
              "confirmedPayload",
              currentState,
              timestampMs,
              `${payloadId}:instruction`,
              providerReportedCostUsd,
            ),
          );
        }
        if (!explicitReference(text)) continue;
        addCatalogMatches(catalog?.matchPathEvidence(text) ?? [], "reference", "reference");
        const ambiguous = catalog?.ambiguousPathEvidence(text) ?? 0;
        if (ambiguous > 0) {
          gaps.push({
            reason: "unattributed",
            count: ambiguous,
            message: "A reusable input name matched multiple file revisions without an exact path.",
          });
        }
      }
    }
  }

  const observations = [...byKey.values()];
  return { observations, gaps };
}

/** Parses one Codex JSONL record and returns sanitized observations only. */
export function parseCodexRepeatedInputLine(
  line: string,
  state: RepeatedInputParserState,
  options: ParseCodexRepeatedInputOptions = {},
): readonly RepeatedInputObservation[] {
  return detailedParseCodexRepeatedInputLine(line, state, options).observations;
}

/** Detailed parser variant used by the importer to retain coverage gaps. */
export function parseCodexRepeatedInputLineDetailed(
  line: string,
  state: RepeatedInputParserState,
  options: ParseCodexRepeatedInputOptions = {},
): RepeatedInputParseResult {
  return detailedParseCodexRepeatedInputLine(line, state, options);
}

export const detectCodexRepeatedInputLine = parseCodexRepeatedInputLine;

export interface RepeatedInputModelCost {
  readonly model: string | null;
  readonly directTokens: RepeatedInputTokenAttribution;
  readonly estimatedApiCostUsd: number | null;
  readonly priceStatus: UsageRepeatedInputPriceStatus;
  readonly occurrences: number;
}

function totalsForDirectTokens(tokens: RepeatedInputTokenAttribution): UsageTokenTotals {
  return {
    uncachedInputTokens: tokens.exact + tokens.estimated,
    cachedInputTokens: tokens.cached,
    cacheCreationTokens: tokens.cacheWrite,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

export function estimateRepeatedInputCost(input: {
  readonly model: string | null;
  readonly directTokens: RepeatedInputTokenAttribution;
  readonly providerReportedCostUsd?: number | null;
  readonly rates: RateTable;
  readonly priceOverrides?: RateTable;
}): Omit<RepeatedInputModelCost, "occurrences"> {
  if (
    input.providerReportedCostUsd !== undefined &&
    input.providerReportedCostUsd !== null &&
    Number.isFinite(input.providerReportedCostUsd) &&
    input.providerReportedCostUsd >= 0
  ) {
    return {
      model: input.model,
      directTokens: input.directTokens,
      estimatedApiCostUsd: input.providerReportedCostUsd,
      priceStatus: "providerReported",
    };
  }
  if (input.model === null || input.directTokens.unknown > 0) {
    return {
      model: input.model,
      directTokens: input.directTokens,
      estimatedApiCostUsd: null,
      priceStatus: "unpriced",
    };
  }
  if (
    input.directTokens.exact +
      input.directTokens.estimated +
      input.directTokens.cached +
      input.directTokens.cacheWrite ===
    0
  ) {
    return {
      model: input.model,
      directTokens: input.directTokens,
      estimatedApiCostUsd: null,
      priceStatus: "unpriced",
    };
  }
  const priced = priceUsage(
    input.rates,
    input.model,
    totalsForDirectTokens(input.directTokens),
    null,
    undefined,
    input.priceOverrides,
  );
  return {
    model: input.model,
    directTokens: input.directTokens,
    estimatedApiCostUsd: priced.costSource === "unpriced" ? null : priced.costUsd,
    priceStatus: priced.costSource === "unpriced" ? "unpriced" : "estimated",
  };
}

export interface RepeatedInputAggregateOptions {
  readonly rates: RateTable;
  readonly priceOverrides?: RateTable;
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly dayAt?: (timestampMs: number) => string;
  readonly coverageGaps?: readonly UsageRepeatedInputCoverageGap[];
}

export interface RepeatedInputAggregateBreakdown {
  readonly sourceKind: UsageRepeatedInputSourceKind;
  readonly model: string | null;
  readonly project: string | null;
  readonly environment: string | null;
  readonly day: string;
  readonly occurrences: number;
  readonly sessions: number;
  readonly turns: number;
  readonly directTokens: RepeatedInputTokenAttribution;
  readonly fullSessionInputTokens: RepeatedInputTokenAttribution;
  readonly estimatedApiCostUsd: number | null;
  readonly priceStatus: UsageRepeatedInputPriceStatus;
}

export interface RepeatedInputAggregateItem {
  readonly displayName: string;
  readonly sourceKind: UsageRepeatedInputSourceKind;
  readonly contentHash: string;
  readonly fileRevisionHash: string | null;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
  readonly occurrences: number;
  readonly affectedSessions: number;
  readonly affectedTurns: number;
  readonly confidence: UsageRepeatedInputConfidence;
  readonly confidenceCounts: Readonly<Record<UsageRepeatedInputConfidence, number>>;
  readonly directTokens: RepeatedInputTokenAttribution;
  readonly fullSessionInputTokens: RepeatedInputTokenAttribution;
  readonly modelCosts: readonly RepeatedInputModelCost[];
  readonly breakdowns: readonly RepeatedInputAggregateBreakdown[];
}

export interface RepeatedInputAggregateResult {
  readonly items: readonly RepeatedInputAggregateItem[];
  readonly totals: readonly RepeatedInputAggregateBreakdown[];
  readonly coverageGaps: readonly UsageRepeatedInputCoverageGap[];
  readonly estimatedApiCostUsd: number | null;
  readonly priceStatus: UsageRepeatedInputPriceStatus;
}

function addTokens(
  a: RepeatedInputTokenAttribution,
  b: RepeatedInputTokenAttribution,
): RepeatedInputTokenAttribution {
  return {
    exact: a.exact + b.exact,
    estimated: a.estimated + b.estimated,
    cached: a.cached + b.cached,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    unknown: a.unknown + b.unknown,
  };
}

interface MutableAggregateBreakdown {
  readonly sourceKind: UsageRepeatedInputSourceKind;
  readonly model: string | null;
  readonly project: string | null;
  readonly environment: string | null;
  readonly day: string;
  occurrences: number;
  sessions: Set<string>;
  turns: Set<string>;
  fullSessions: Set<string>;
  directTokens: RepeatedInputTokenAttribution;
  fullSessionInputTokens: RepeatedInputTokenAttribution;
  estimatedApiCostUsd: number | null;
  priceStatus: UsageRepeatedInputPriceStatus;
}

function dayFor(timestampMs: number, dayAt?: (timestampMs: number) => string): string {
  return dayAt?.(timestampMs) ?? new Date(timestampMs).toISOString().slice(0, 10);
}

function breakdownKey(
  sourceKind: UsageRepeatedInputSourceKind,
  model: string | null,
  project: string | null,
  environment: string | null,
  day: string,
): string {
  return [sourceKind, model ?? "", project ?? "", environment ?? "", day].join("\u0000");
}

function newBreakdown(
  input: Omit<
    MutableAggregateBreakdown,
    | "occurrences"
    | "sessions"
    | "turns"
    | "fullSessions"
    | "directTokens"
    | "fullSessionInputTokens"
    | "estimatedApiCostUsd"
    | "priceStatus"
  >,
): MutableAggregateBreakdown {
  return {
    ...input,
    occurrences: 0,
    sessions: new Set<string>(),
    turns: new Set<string>(),
    fullSessions: new Set<string>(),
    directTokens: EMPTY_REPEATED_INPUT_TOKENS,
    fullSessionInputTokens: EMPTY_REPEATED_INPUT_TOKENS,
    estimatedApiCostUsd: null,
    priceStatus: "estimated",
  };
}

function mergeCost(
  current: number | null,
  currentStatus: UsageRepeatedInputPriceStatus,
  next: Omit<RepeatedInputModelCost, "occurrences">,
): { readonly cost: number | null; readonly status: UsageRepeatedInputPriceStatus } {
  const status =
    currentStatus === "unpriced" || next.priceStatus === "unpriced"
      ? "unpriced"
      : currentStatus === "providerReported" || next.priceStatus === "providerReported"
        ? "providerReported"
        : "estimated";
  const cost =
    current === null
      ? next.estimatedApiCostUsd
      : next.estimatedApiCostUsd === null
        ? current
        : current + next.estimatedApiCostUsd;
  return { cost, status };
}

/** Aggregates observations without ever treating full-session input as item cost. */
export function aggregateRepeatedInputObservations(
  observations: readonly RepeatedInputObservation[],
  options: RepeatedInputAggregateOptions,
): RepeatedInputAggregateResult {
  const bestEvidence = new Map<string, RepeatedInputObservation>();
  for (const observation of observations) {
    const previous = bestEvidence.get(observation.dedupeKey);
    if (
      previous === undefined ||
      confidenceRank(observation.confidence) > confidenceRank(previous.confidence)
    ) {
      bestEvidence.set(observation.dedupeKey, observation);
    }
  }
  const uniqueObservations = [...bestEvidence.values()];
  const toolOperationOccurrences = new Map<string, number>();
  for (const observation of uniqueObservations) {
    if (observation.sourceKind !== "toolOperation") continue;
    const key = `${observation.sourceKind}\u0000${observation.contentHash}`;
    toolOperationOccurrences.set(key, (toolOperationOccurrences.get(key) ?? 0) + 1);
  }
  const itemMaps = new Map<
    string,
    {
      displayName: string;
      sourceKind: UsageRepeatedInputSourceKind;
      contentHash: string;
      fileRevisionHash: string | null;
      firstObservedAtMs: number;
      lastObservedAtMs: number;
      occurrences: number;
      sessions: Set<string>;
      turns: Set<string>;
      fullSessions: Set<string>;
      confidence: UsageRepeatedInputConfidence;
      confidenceCounts: Record<UsageRepeatedInputConfidence, number>;
      directTokens: RepeatedInputTokenAttribution;
      fullSessionInputTokens: RepeatedInputTokenAttribution;
      modelCosts: Map<string, RepeatedInputModelCost>;
      breakdowns: Map<string, MutableAggregateBreakdown>;
    }
  >();
  const totals = new Map<string, MutableAggregateBreakdown>();
  let combinedCost: number | null = null;
  let combinedStatus: UsageRepeatedInputPriceStatus = "estimated";
  let missingModels = 0;
  let missingTokenizers = 0;

  for (const input of uniqueObservations) {
    if (
      (options.sinceMs !== undefined && input.observedAtMs < options.sinceMs) ||
      (options.untilMs !== undefined && input.observedAtMs >= options.untilMs)
    ) {
      continue;
    }
    const itemKey = `${input.sourceKind}\u0000${input.contentHash}`;
    // A typed tool operation becomes repeated input only after the exact same
    // operation payload is observed more than once. This keeps one-off shell
    // commands and arbitrary tool use out of the report.
    if (input.sourceKind === "toolOperation" && (toolOperationOccurrences.get(itemKey) ?? 0) < 2) {
      continue;
    }
    if (input.model === null) missingModels += 1;
    if (
      input.confidence !== "reference" &&
      input.directTokens.exact +
        input.directTokens.estimated +
        input.directTokens.cached +
        input.directTokens.cacheWrite ===
        0
    ) {
      missingTokenizers += 1;
    }
    let item = itemMaps.get(itemKey);
    if (item === undefined) {
      item = {
        displayName: input.displayName,
        sourceKind: input.sourceKind,
        contentHash: input.contentHash,
        fileRevisionHash: input.fileRevisionHash,
        firstObservedAtMs: input.observedAtMs,
        lastObservedAtMs: input.observedAtMs,
        occurrences: 0,
        sessions: new Set<string>(),
        turns: new Set<string>(),
        fullSessions: new Set<string>(),
        confidence: input.confidence,
        confidenceCounts: { reference: 0, likelyRead: 0, confirmedPayload: 0 },
        directTokens: EMPTY_REPEATED_INPUT_TOKENS,
        fullSessionInputTokens: EMPTY_REPEATED_INPUT_TOKENS,
        modelCosts: new Map<string, RepeatedInputModelCost>(),
        breakdowns: new Map<string, MutableAggregateBreakdown>(),
      };
      itemMaps.set(itemKey, item);
    }
    item.occurrences += 1;
    item.firstObservedAtMs = Math.min(item.firstObservedAtMs, input.observedAtMs);
    item.lastObservedAtMs = Math.max(item.lastObservedAtMs, input.observedAtMs);
    if (input.fileRevisionHash !== null) item.fileRevisionHash = input.fileRevisionHash;
    if (confidenceRank(input.confidence) > confidenceRank(item.confidence)) {
      item.confidence = input.confidence;
    }
    item.confidenceCounts[input.confidence] += 1;
    if (input.sessionId.length > 0) item.sessions.add(input.sessionId);
    if (input.turnId !== null) item.turns.add(`${input.sessionId}\u0000${input.turnId}`);
    item.directTokens = addTokens(item.directTokens, input.directTokens);
    const fullSessionKey = input.sessionId || input.dedupeKey;
    if (!item.fullSessions.has(fullSessionKey)) {
      item.fullSessions.add(fullSessionKey);
      item.fullSessionInputTokens = addTokens(
        item.fullSessionInputTokens,
        input.fullSessionInputTokens,
      );
    }

    const modelKey = input.model ?? "";
    const modelCost = estimateRepeatedInputCost({
      model: input.model,
      directTokens: input.directTokens,
      providerReportedCostUsd: input.providerReportedCostUsd,
      rates: options.rates,
      ...(options.priceOverrides === undefined ? {} : { priceOverrides: options.priceOverrides }),
    });
    const existingModel = item.modelCosts.get(modelKey);
    if (existingModel === undefined) {
      item.modelCosts.set(modelKey, { ...modelCost, occurrences: 1 });
    } else {
      const merged = mergeCost(
        existingModel.estimatedApiCostUsd,
        existingModel.priceStatus,
        modelCost,
      );
      item.modelCosts.set(modelKey, {
        model: existingModel.model,
        directTokens: addTokens(existingModel.directTokens, modelCost.directTokens),
        estimatedApiCostUsd: merged.cost,
        priceStatus: merged.status,
        occurrences: existingModel.occurrences + 1,
      });
    }

    const day = dayFor(input.observedAtMs, options.dayAt);
    const key = breakdownKey(input.sourceKind, input.model, input.project, input.environment, day);
    const updateBreakdown = (map: Map<string, MutableAggregateBreakdown>) => {
      let breakdown = map.get(key);
      if (breakdown === undefined) {
        breakdown = newBreakdown({
          sourceKind: input.sourceKind,
          model: input.model,
          project: input.project,
          environment: input.environment,
          day,
        });
        map.set(key, breakdown);
      }
      breakdown.occurrences += 1;
      if (input.sessionId.length > 0) breakdown.sessions.add(input.sessionId);
      if (input.turnId !== null) breakdown.turns.add(`${input.sessionId}\u0000${input.turnId}`);
      breakdown.directTokens = addTokens(breakdown.directTokens, input.directTokens);
      if (!breakdown.fullSessions.has(fullSessionKey)) {
        breakdown.fullSessions.add(fullSessionKey);
        breakdown.fullSessionInputTokens = addTokens(
          breakdown.fullSessionInputTokens,
          input.fullSessionInputTokens,
        );
      }
      const merged = mergeCost(breakdown.estimatedApiCostUsd, breakdown.priceStatus, modelCost);
      breakdown.estimatedApiCostUsd = merged.cost;
      breakdown.priceStatus = merged.status;
    };
    updateBreakdown(item.breakdowns);
    updateBreakdown(totals);
    const mergedCombined = mergeCost(combinedCost, combinedStatus, modelCost);
    combinedCost = mergedCombined.cost;
    combinedStatus = mergedCombined.status;
  }

  const freezeBreakdown = (value: MutableAggregateBreakdown): RepeatedInputAggregateBreakdown => ({
    sourceKind: value.sourceKind,
    model: value.model,
    project: value.project,
    environment: value.environment,
    day: value.day,
    occurrences: value.occurrences,
    sessions: value.sessions.size,
    turns: value.turns.size,
    directTokens: value.directTokens,
    fullSessionInputTokens: value.fullSessionInputTokens,
    estimatedApiCostUsd: value.estimatedApiCostUsd,
    priceStatus: value.priceStatus,
  });
  const items = [...itemMaps.values()]
    .sort((left, right) => right.lastObservedAtMs - left.lastObservedAtMs)
    .map((item) => ({
      displayName: item.displayName,
      sourceKind: item.sourceKind,
      contentHash: item.contentHash,
      fileRevisionHash: item.fileRevisionHash,
      firstObservedAtMs: item.firstObservedAtMs,
      lastObservedAtMs: item.lastObservedAtMs,
      occurrences: item.occurrences,
      affectedSessions: item.sessions.size,
      affectedTurns: item.turns.size,
      confidence: item.confidence,
      confidenceCounts: item.confidenceCounts,
      directTokens: item.directTokens,
      fullSessionInputTokens: item.fullSessionInputTokens,
      modelCosts: [...item.modelCosts.values()].sort(
        (left, right) => left.model?.localeCompare(right.model ?? "") ?? -1,
      ),
      breakdowns: [...item.breakdowns.values()].map(freezeBreakdown),
    }));
  const coverageGaps = [...(options.coverageGaps ?? [])];
  if (missingModels > 0) {
    coverageGaps.push({
      reason: "missingModel",
      count: missingModels,
      message: "The transcript did not identify a model for a repeated-input observation.",
    });
  }
  if (missingTokenizers > 0) {
    coverageGaps.push({
      reason: "missingTokenizer",
      count: missingTokenizers,
      message: "A matching tokenizer was unavailable for a repeated-input payload.",
    });
  }
  return {
    items,
    totals: [...totals.values()].map(freezeBreakdown),
    coverageGaps,
    estimatedApiCostUsd: combinedCost,
    priceStatus: combinedStatus,
  };
}
