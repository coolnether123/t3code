// @effect-diagnostics nodeBuiltinImport:off - bounded raw ledger reads follow usageTranscriptReader.
// @effect-diagnostics globalDate:off - parses retained timestamps, never reads the clock.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import type { UsageRecord } from "./usageTranscripts.ts";

export interface QwenRouterUsageSource {
  /** Stable identity of one router store, shared by its active and archived files. */
  readonly sourceId: string;
  readonly files: readonly string[];
  /** Exact non-native source labels accepted for additive local accounting. */
  readonly additiveSources: readonly string[];
}

export interface QwenRouterReadLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxLineBytes: number;
  readonly maxRows: number;
  readonly maxJobs: number;
}

export const QWEN_ROUTER_READ_LIMITS: QwenRouterReadLimits = {
  maxFiles: 32,
  maxBytes: 32 * 1024 * 1024,
  maxLineBytes: 64 * 1024,
  maxRows: 100_000,
  maxJobs: 10_000,
};

export type QwenRouterDisposition =
  | "additive"
  | "excludedNative"
  | "excludedCloud"
  | "unattributed";

/** Reader-local contract. Nullable measurements cannot enter the current native cache unchanged. */
export interface QwenRouterJobUsage extends Pick<UsageRecord, "reportedCostUsd" | "sessionId"> {
  readonly provider: "qwen-router";
  readonly sourceId: string;
  readonly jobId: string;
  readonly dedupeKey: string;
  readonly timestampMs: number | null;
  readonly model: string | null;
  readonly routerRunId: string | null;
  readonly requestId: string | null;
  readonly backendTargetId: string | null;
  readonly backendTargetKind: string | null;
  readonly source: string | null;
  readonly clientOriginator: string | null;
  readonly jobType: string | null;
  readonly nativeProvider: "codex" | "opencode" | null;
  /** The current job ledger does not emit native session or provider response IDs. */
  readonly nativeSessionId: null;
  readonly providerResponseId: null;
  readonly disposition: QwenRouterDisposition;
  readonly usageStatus: "partial" | "missing";
  readonly recorded: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly totalTokens: number | null;
    readonly inputSource: string | null;
  };
  readonly measured: {
    readonly inputTokens: number | null;
    readonly outputTokens: null;
    readonly cachedInputTokens: null;
    readonly cacheCreationTokens: null;
    readonly reasoningTokens: null;
  };
  readonly issues: readonly string[];
}

export interface QwenRouterParseCounters {
  rows: number;
  ignoredRows: number;
  malformedRows: number;
  invalidRows: number;
  invalidCounters: number;
  unknownCounters: number;
  unknownMeasuredCounters: number;
  unknownSources: number;
  duplicateCopies: number;
  conflictingJobs: number;
  oversizedRows: number;
}

export interface QwenRouterFileCoverage {
  readonly file: string;
  readonly status: "complete" | "partial" | "missing" | "unavailable" | "notRead";
  readonly size: number | null;
  readonly mtimeMs: number | null;
  readonly bytesRead: number;
  readonly changedDuringRead: boolean;
  readonly reason: string | null;
}

export interface QwenRouterUsageRead {
  readonly sourceId: string;
  readonly status: "complete" | "partial" | "missing";
  readonly records: readonly QwenRouterJobUsage[];
  readonly coverage: readonly QwenRouterFileCoverage[];
  readonly counters: Readonly<QwenRouterParseCounters>;
  readonly rejectedJobKeys: readonly string[];
}

const Label = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\s\p{Cc}](?:[^\p{Cc}]*[^\s\p{Cc}])?$/u),
);
const decodeLabel = Schema.decodeUnknownOption(Label);
const decodeCounter = Schema.decodeUnknownOption(
  Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
);
const decodeRow = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const metadataFields = [
  "job_id",
  "source",
  "client_originator",
  "job_type",
  "router_run_id",
  "request_id",
  "backend_target_id",
  "backend_target_kind",
  "actual_model",
  "requested_model",
  "backend_model",
  "end_time",
  "ended_at",
  "prompt_tokens",
  "completion_tokens",
  "token_count",
  "prompt_tokens_source",
] as const;

const label = (value: unknown) => Option.getOrNull(decodeLabel(value));
const counter = (value: unknown) => Option.getOrNull(decodeCounter(value));

function sourceKind(
  value: string | null,
): "codex" | "opencode" | "ambiguous" | "other" | "unknown" {
  if (value === null) return "unknown";
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (["unknown", "none", "null"].includes(normalized)) return "unknown";
  if (
    ["codex", "codex_cli", "codex_desktop", "codex_cli_worker", "openai_codex"].includes(normalized)
  )
    return "codex";
  if (["opencode", "open_code", "opencode_cli"].includes(normalized)) return "opencode";
  if (
    normalized.includes("codex") ||
    normalized.includes("opencode") ||
    normalized.includes("open_code")
  )
    return "ambiguous";
  return "other";
}

export type QwenRouterLineOutcome =
  | { readonly kind: "ignored" | "malformed" | "invalid" }
  | {
      readonly kind: "job";
      readonly record: QwenRouterJobUsage;
      readonly fingerprint: string;
      readonly invalidCounters: number;
      readonly unknownCounters: number;
      readonly unknownSource: boolean;
    };

function parseJobCounters(row: Record<string, unknown>) {
  const issues: string[] = [];
  const inputs = ["prompt_tokens", "completion_tokens", "token_count"] as const;
  let invalidCounters = 0;
  let unknownCounters = 0;
  for (const field of inputs) {
    if (row[field] == null) unknownCounters += 1;
    else if (counter(row[field]) === null) {
      invalidCounters += 1;
      issues.push(`invalid:${field}`);
    }
  }
  const inputTokens = counter(row["prompt_tokens"]);
  const outputTokens = counter(row["completion_tokens"]);
  const totalTokens = counter(row["token_count"]);
  const inputSource = label(row["prompt_tokens_source"]);
  return {
    recorded: { inputTokens, outputTokens, totalTokens, inputSource },
    invalidCounters,
    unknownCounters,
    issues,
  };
}

function classifyJobSource(row: Record<string, unknown>, source: QwenRouterUsageSource) {
  const clientSource = label(row["source"]);
  const originator = label(row["client_originator"]);
  const client = sourceKind(clientSource);
  const origin = sourceKind(originator);
  const nativeProvider =
    client === "codex" || client === "opencode"
      ? client
      : origin === "codex" || origin === "opencode"
        ? origin
        : null;
  const targetKind = label(row["backend_target_kind"]);
  const conflictingNativeProviders =
    (client === "codex" || client === "opencode") &&
    (origin === "codex" || origin === "opencode") &&
    client !== origin;
  const ambiguous = client === "ambiguous" || origin === "ambiguous" || conflictingNativeProviders;
  const unknownSource =
    ambiguous ||
    client === "unknown" ||
    (nativeProvider === null && !source.additiveSources.includes(clientSource ?? ""));
  const disposition: QwenRouterDisposition =
    targetKind === "remote_openai_compatible"
      ? "excludedCloud"
      : ambiguous
        ? "unattributed"
        : nativeProvider !== null
          ? "excludedNative"
          : targetKind === "local_llama" &&
              client === "other" &&
              source.additiveSources.includes(clientSource ?? "")
            ? "additive"
            : "unattributed";
  return {
    source: clientSource,
    clientOriginator: originator,
    backendTargetKind: targetKind,
    nativeProvider: conflictingNativeProviders ? null : nativeProvider,
    disposition,
    unknownSource,
  };
}

/** Reads only terminal job metadata. Model-usage and lifecycle rows are not another usage source. */
export function parseQwenRouterLine(
  line: string,
  source: QwenRouterUsageSource,
): QwenRouterLineOutcome {
  const parsed = decodeRow(line);
  if (Option.isNone(parsed)) return { kind: "malformed" };
  const row = parsed.value;
  if (row["event"] !== "job_finished") return { kind: "ignored" };
  const jobId = label(row["job_id"]);
  if (jobId === null) return { kind: "invalid" };
  const counts = parseJobCounters(row);
  const issues = counts.issues;
  const measuredInput =
    counts.recorded.inputSource === "usage" ? counts.recorded.inputTokens : null;
  if (measuredInput === null) issues.push("unknown:measuredInputTokens");
  // extract_stream_metrics may estimate completion_tokens without marking its provenance.
  issues.push("unknown:measuredOutputTokens");
  const end = row["end_time"] ?? row["ended_at"];
  const timestampMs =
    typeof end === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(end) ? Date.parse(end) : NaN;
  const model =
    label(row["actual_model"]) ?? label(row["backend_model"]) ?? label(row["requested_model"]);
  if (!Number.isFinite(timestampMs)) issues.push("unknown:terminalTimestamp");
  if (model === null) issues.push("unknown:model");
  const { unknownSource, ...attribution } = classifyJobSource(row, source);
  const disposition =
    attribution.disposition === "additive" &&
    (!Number.isFinite(timestampMs) || model === null || counts.invalidCounters > 0)
      ? "unattributed"
      : attribution.disposition;
  if (disposition === "unattributed") issues.push("unattributed");
  const dedupeKey = `qwen-router:job:${JSON.stringify([source.sourceId, jobId])}`;
  return {
    kind: "job",
    fingerprint: NodeCrypto.createHash("sha256")
      .update(JSON.stringify(metadataFields.map((field) => row[field] ?? null)))
      .digest("hex"),
    invalidCounters: counts.invalidCounters,
    unknownCounters: counts.unknownCounters,
    unknownSource,
    record: {
      provider: "qwen-router",
      sourceId: source.sourceId,
      jobId,
      sessionId: dedupeKey,
      dedupeKey,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
      model,
      routerRunId: label(row["router_run_id"]),
      requestId: label(row["request_id"]),
      backendTargetId: label(row["backend_target_id"]),
      ...attribution,
      jobType: label(row["job_type"]),
      nativeSessionId: null,
      providerResponseId: null,
      disposition,
      usageStatus: measuredInput === null ? "missing" : "partial",
      recorded: counts.recorded,
      measured: {
        inputTokens: measuredInput,
        outputTokens: null,
        cachedInputTokens: null,
        cacheCreationTokens: null,
        reasoningTokens: null,
      },
      reportedCostUsd: null,
      issues,
    },
  };
}

function validateConfiguration(source: QwenRouterUsageSource, limits: QwenRouterReadLimits): void {
  if (
    label(source.sourceId) === null ||
    source.files.length === 0 ||
    source.files.some((file) => !NodePath.isAbsolute(file)) ||
    source.additiveSources.some((value) => label(value) === null || sourceKind(value) !== "other")
  ) {
    throw new TypeError(
      "Router usage requires a stable source ID, absolute files and non-native additive source labels.",
    );
  }
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError("Router usage read limits must be positive safe integers.");
  }
}

/** Bounded snapshot of explicitly configured JSONL files. Partial snapshots are provisional. */
export async function readQwenRouterUsage(
  source: QwenRouterUsageSource,
  overrides: Partial<QwenRouterReadLimits> = {},
): Promise<QwenRouterUsageRead> {
  const limits = { ...QWEN_ROUTER_READ_LIMITS, ...overrides };
  validateConfiguration(source, limits);
  const counters: QwenRouterParseCounters = {
    rows: 0,
    ignoredRows: 0,
    malformedRows: 0,
    invalidRows: 0,
    invalidCounters: 0,
    unknownCounters: 0,
    unknownMeasuredCounters: 0,
    unknownSources: 0,
    duplicateCopies: 0,
    conflictingJobs: 0,
    oversizedRows: 0,
  };
  const jobs = new Map<string, Extract<QwenRouterLineOutcome, { kind: "job" }>>();
  const rejected = new Set<string>();
  const coverage: QwenRouterFileCoverage[] = [];
  let bytesRead = 0;
  let stopped = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const consume = (line: Uint8Array) => {
    counters.rows += 1;
    let text: string;
    try {
      text = decoder.decode(line);
    } catch {
      counters.malformedRows += 1;
      return;
    }
    const outcome = parseQwenRouterLine(text, source);
    if (outcome.kind !== "job") {
      if (outcome.kind === "ignored") counters.ignoredRows += 1;
      if (outcome.kind === "malformed") counters.malformedRows += 1;
      if (outcome.kind === "invalid") counters.invalidRows += 1;
      return;
    }
    counters.invalidCounters += outcome.invalidCounters;
    counters.unknownCounters += outcome.unknownCounters;
    counters.unknownMeasuredCounters += outcome.record.measured.inputTokens === null ? 2 : 1;
    if (outcome.unknownSource) counters.unknownSources += 1;
    const key = outcome.record.dedupeKey;
    if (rejected.has(key)) return;
    const existing = jobs.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint === outcome.fingerprint) counters.duplicateCopies += 1;
      else {
        jobs.delete(key);
        rejected.add(key);
        counters.conflictingJobs += 1;
      }
    } else if (jobs.size + rejected.size >= limits.maxJobs) stopped = true;
    else jobs.set(key, outcome);
  };
  const files = [...new Set(source.files)];
  for (const [index, file] of files.entries()) {
    if (
      stopped ||
      index >= limits.maxFiles ||
      bytesRead >= limits.maxBytes ||
      counters.rows >= limits.maxRows
    ) {
      coverage.push({
        file,
        status: "notRead",
        size: null,
        mtimeMs: null,
        bytesRead: 0,
        changedDuringRead: false,
        reason: "limit",
      });
      continue;
    }
    const result = await readJobFile(
      file,
      limits,
      limits.maxBytes - bytesRead,
      () => stopped || counters.rows >= limits.maxRows,
      consume,
      counters,
    );
    coverage.push(result);
    bytesRead += result.bytesRead;
  }
  const hasGaps =
    counters.malformedRows +
      counters.invalidRows +
      counters.invalidCounters +
      counters.conflictingJobs +
      counters.oversizedRows >
    0;
  const status = coverage.every((file) => file.status === "missing")
    ? "missing"
    : hasGaps || coverage.some((file) => file.status !== "complete")
      ? "partial"
      : "complete";
  return {
    sourceId: source.sourceId,
    status,
    records: [...jobs.values()].map((job) => job.record),
    coverage,
    counters,
    rejectedJobKeys: [...rejected],
  };
}

async function readJobFile(
  file: string,
  limits: QwenRouterReadLimits,
  budget: number,
  stopped: () => boolean,
  consume: (line: Uint8Array) => void,
  counters: QwenRouterParseCounters,
): Promise<QwenRouterFileCoverage> {
  let handle: NodeFSP.FileHandle | undefined;
  let size: number | null = null;
  let mtimeMs: number | null = null;
  let bytesRead = 0;
  try {
    handle = await NodeFSP.open(file, "r");
    const before = await handle.stat();
    size = before.size;
    mtimeMs = before.mtimeMs;
    if (!before.isFile())
      return {
        file,
        status: "unavailable",
        size,
        mtimeMs,
        bytesRead,
        changedDuringRead: false,
        reason: "notFile",
      };
    const buffer = Buffer.alloc(Math.min(64 * 1024, budget));
    let pending = Buffer.alloc(0);
    let discarding = false;
    while (bytesRead < Math.min(size, budget) && !stopped()) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - bytesRead, budget - bytesRead),
        bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
      let offset = 0;
      while (offset < read.bytesRead && !stopped()) {
        const newline = buffer.indexOf(10, offset);
        const end = newline >= 0 && newline < read.bytesRead ? newline : read.bytesRead;
        const part = buffer.subarray(offset, end);
        if (!discarding) {
          if (pending.length + part.length > limits.maxLineBytes) {
            pending = Buffer.alloc(0);
            discarding = true;
            counters.oversizedRows += 1;
            counters.rows += 1;
          } else pending = Buffer.concat([pending, part]);
        }
        offset = end + 1;
        if (end < read.bytesRead) {
          if (!discarding && pending.length > 0) consume(pending);
          pending = Buffer.alloc(0);
          discarding = false;
        }
      }
    }
    const after = await handle.stat();
    const current = await NodeFSP.stat(file);
    const changedDuringRead =
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      after.size !== current.size ||
      after.mtimeMs !== current.mtimeMs;
    const partial =
      bytesRead < size || stopped() || pending.length > 0 || discarding || changedDuringRead;
    return {
      file,
      status: partial ? "partial" : "complete",
      size,
      mtimeMs,
      bytesRead,
      changedDuringRead,
      reason: changedDuringRead
        ? "changed"
        : pending.length > 0 || discarding
          ? "unterminatedLine"
          : partial
            ? "limit"
            : null,
    };
  } catch (error) {
    const missing =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    return {
      file,
      status: missing && handle === undefined ? "missing" : "unavailable",
      size,
      mtimeMs,
      bytesRead,
      changedDuringRead: handle !== undefined,
      reason: missing ? "missing" : "readError",
    };
  } finally {
    await handle?.close();
  }
}
