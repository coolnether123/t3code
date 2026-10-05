// @effect-diagnostics nodeBuiltinImport:off - bounded metadata reads use the native transcript I/O boundary.
// @effect-diagnostics globalDate:off - parses retained timestamps; the caller supplies current time.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type {
  UsageAccountingObservation,
  UsageReportInput,
  UsageReportObservations,
} from "@t3tools/contracts";
import { AcpUsageMetadata } from "../provider/acp/AcpUsage.ts";
import { readQwenRouterUsage } from "./usageQwenRouter.ts";

const Label = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,511}$/));
const SourceId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/));
const Files = Schema.Array(Schema.String.check(Schema.isMaxLength(1024))).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
);
const Sources = Schema.Array(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("router"),
      sourceId: SourceId,
      files: Files,
      additiveSources: Schema.Array(SourceId).check(Schema.isMaxLength(32)),
    }),
    Schema.Struct({
      kind: Schema.Literal("acp"),
      sourceId: SourceId,
      files: Files,
      provider: Schema.Literals(["cursor", "grok"]),
    }),
    Schema.Struct({
      kind: Schema.Literal("decisions"),
      sourceId: SourceId,
      baseUrl: Schema.String,
      actorId: Label,
    }),
  ]),
).check(Schema.isMaxLength(16));
const decodeSources = Schema.decodeUnknownSync(Schema.fromJsonString(Sources));
const decodeAcp = Schema.decodeUnknownOption(AcpUsageMetadata);
const isLabel = Schema.is(Label);
const counter = Schema.is(
  Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
);
const nullCounters = () => ({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  cacheCreationTokens: null,
  reasoningTokens: null,
});
const rowId = (source: string, identity: string) =>
  NodeCrypto.createHash("sha256")
    .update(source + "\0" + identity)
    .digest("hex");
const label = (value: unknown): string | null => (isLabel(value) ? value : null);
const count = (value: unknown): number | null => (counter(value) ? value : null);
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_LINE = 128 * 1024;
const MAX_ROWS = 10_000;

export function emptyObservationReport(
  input: UsageReportInput,
  readAt: string,
): UsageReportObservations {
  return {
    contractVersion: 1,
    mode: "observations",
    readAt,
    timeZone: input.timeZone,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    accounting: "separateMetadataNotNativeTotals",
    coverage: {
      status: "missing",
      configuredSources: 0,
      scannedFiles: 0,
      malformedRecords: 0,
      duplicateRecords: 0,
      conflictingRecords: 0,
      excludedNative: 0,
      excludedCloud: 0,
      reasons: ["sources-unconfigured"],
    },
    rows: [],
    totalRows: 0,
    truncated: false,
  };
}

async function safeMetadataFile(file: string) {
  if (!NodePath.isAbsolute(file)) throw new Error("metadata-path-invalid");
  let current = NodePath.resolve(file);
  while (true) {
    if ((await NodeFSP.lstat(current)).isSymbolicLink()) throw new Error("metadata-path-linked");
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const stat = await NodeFSP.stat(file);
  if (!stat.isFile()) throw new Error("metadata-file-invalid");
  return stat;
}

/** Host configuration selects sources; query arguments never select paths, URLs or actors. */
export async function readUsageObservations(
  input: UsageReportInput,
  options: {
    readonly configuration?: string;
    readonly readAt: string;
    readonly fetcher?: (input: URL, init: RequestInit) => Promise<Response>;
    readonly signal?: AbortSignal;
    readonly maxBytes?: number;
    readonly maxLines?: number;
  },
): Promise<UsageReportObservations> {
  if (
    input.mode !== "observations" ||
    input.providers !== undefined ||
    input.runIds !== undefined ||
    input.threadIds !== undefined ||
    input.quotaIntervals !== undefined ||
    input.resolution !== undefined ||
    input.sinceTime !== undefined ||
    input.untilTime !== undefined ||
    input.sinceDay > input.untilDay ||
    !Number.isFinite(Date.parse(input.sinceDay)) ||
    !Number.isFinite(Date.parse(input.untilDay)) ||
    Date.parse(input.untilDay) - Date.parse(input.sinceDay) > 365 * 86400000 ||
    (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 512))
  ) {
    throw new Error("observation-window-invalid");
  }
  const dayAt = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  if (options.configuration === undefined) return emptyObservationReport(input, options.readAt);
  const sources = decodeSources(options.configuration);
  if (new Set(sources.map((source) => source.sourceId)).size !== sources.length)
    throw new Error("observation-source-conflict");
  const coverage = {
    configuredSources: sources.length,
    scannedFiles: 0,
    malformedRecords: 0,
    duplicateRecords: 0,
    conflictingRecords: 0,
    excludedNative: 0,
    excludedCloud: 0,
  };
  const reasons = new Set<string>();
  const rows = new Map<string, UsageAccountingObservation>();
  const rejected = new Set<string>();
  let bytesLeft = Math.min(MAX_BYTES, options.maxBytes ?? MAX_BYTES);
  let linesLeft = Math.min(100_000, options.maxLines ?? 100_000);
  if (
    !Number.isSafeInteger(bytesLeft) ||
    !Number.isSafeInteger(linesLeft) ||
    bytesLeft < 1 ||
    linesLeft < 1
  )
    throw new Error("observation-budget-invalid");
  const signal = AbortSignal.any([
    AbortSignal.timeout(10_000),
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);
  const add = (row: UsageAccountingObservation) => {
    if (row.observedAt === null || !Number.isFinite(Date.parse(row.observedAt))) {
      reasons.add("unknown-time");
      return;
    }
    const day = dayAt.format(Date.parse(row.observedAt));
    if (day < input.sinceDay || day > input.untilDay) return;
    if (rejected.has(row.id)) return;
    const previous = rows.get(row.id);
    if (previous !== undefined) {
      if (
        JSON.stringify({ ...previous, observedAt: null }) ===
        JSON.stringify({ ...row, observedAt: null })
      )
        coverage.duplicateRecords++;
      else {
        rows.delete(row.id);
        rejected.add(row.id);
        coverage.conflictingRecords++;
        reasons.add("conflicting-receipt");
      }
      return;
    }
    if (rows.size >= MAX_ROWS) {
      reasons.add("retained-row-limit");
      return;
    }
    rows.set(row.id, row);
    if (row.issues.length || Object.values(row.counters).some((value) => value === null))
      reasons.add("unknown-measurements");
  };
  const common = (
    sourceId: string,
    provider: UsageAccountingObservation["provider"],
    id: string,
  ): UsageAccountingObservation => ({
    id: rowId(sourceId, id),
    sourceId,
    provider,
    runId: null,
    turnId: null,
    requestId: null,
    nativeJobId: null,
    model: null,
    observedAt: null,
    basis: "unknown",
    disposition: "separate",
    counters: nullCounters(),
    recordedInputTokens: null,
    recordedOutputTokens: null,
    contextUsedTokens: null,
    contextSizeTokens: null,
    reportedCost: null,
    taskIds: [],
    issues: [],
  });

  for (const source of sources) {
    if (bytesLeft <= 0 || linesLeft <= 0) {
      reasons.add("scan-budget");
      break;
    }
    try {
      signal.throwIfAborted();
      if (source.kind === "router") {
        const read = await readQwenRouterUsage(source, {
          maxBytes: bytesLeft,
          maxFiles: 32,
          maxLineBytes: 64 * 1024,
          maxRows: linesLeft,
          maxJobs: MAX_ROWS,
        });
        bytesLeft -= read.coverage.reduce((sum, file) => sum + file.bytesRead, 0);
        linesLeft -= read.counters.rows;
        coverage.scannedFiles += read.coverage.filter(
          (file) => file.status === "complete" || file.status === "partial",
        ).length;
        coverage.malformedRecords += read.counters.malformedRows + read.counters.invalidRows;
        coverage.duplicateRecords += read.counters.duplicateCopies;
        coverage.conflictingRecords += read.counters.conflictingJobs;
        if (read.status !== "complete") reasons.add("source-partial");
        for (const job of read.records) {
          if (job.disposition === "excludedNative") {
            coverage.excludedNative++;
            continue;
          }
          if (job.disposition === "excludedCloud") {
            coverage.excludedCloud++;
            continue;
          }
          const row = common(source.sourceId, "qwen-router", job.dedupeKey);
          add({
            ...row,
            runId: job.jobId,
            nativeJobId: job.jobId,
            requestId: label(job.requestId),
            model: label(job.model),
            observedAt: job.timestampMs === null ? null : new Date(job.timestampMs).toISOString(),
            basis: job.measured.inputTokens === null ? "recorded" : "measured",
            counters: { ...nullCounters(), inputTokens: job.measured.inputTokens },
            recordedInputTokens: job.recorded.inputTokens,
            recordedOutputTokens: job.recorded.outputTokens,
            issues: [...job.issues, "output-provenance-unavailable"].slice(0, 16),
          });
        }
        continue;
      }
      if (source.kind === "decisions") {
        const url = new URL(source.baseUrl);
        if (
          url.protocol !== "http:" ||
          !["127.0.0.1", "[::1]"].includes(url.hostname) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/"
        )
          throw new Error("decision-origin-invalid");
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        for (let page = 0; page < 8; page++) {
          const target = new URL("/api/v1/decisions/usage", url);
          target.searchParams.set("limit", "100");
          if (cursor !== null) target.searchParams.set("cursor", cursor);
          const response = await (options.fetcher ?? fetch)(target, {
            headers: { "X-Otis-Actor": source.actorId },
            redirect: "error",
            signal,
          });
          if (!response.ok || !response.body) throw new Error("decision-source-unavailable");
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 512 * 1024 || size > bytesLeft) throw new Error("decision-response-limit");
            chunks.push(chunk);
          }
          bytesLeft -= size;
          const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const read = decodeDecisionPage(payload);
          if (read.partial) reasons.add("decision-history-partial");
          for (const value of read.rows) {
            const row = common(source.sourceId, "otis-decisions", value.id);
            add({
              ...row,
              runId: label(value.batchId),
              requestId: label(value.providerResponseId),
              nativeJobId: label(value.nativeJobId),
              model: label(value.model),
              observedAt: value.startedAt,
              basis: value.usageState === "measured" ? "measured" : "unknown",
              disposition: value.nativeJobId === null ? "separate" : "correlationOnly",
              counters: {
                ...nullCounters(),
                inputTokens: value.inputTokens,
                outputTokens: value.outputTokens,
              },
              reportedCost:
                value.reportedCostUsd === null
                  ? null
                  : { amount: value.reportedCostUsd, currency: "USD", scope: "providerCall" },
              taskIds: [...value.taskIds],
              issues: value.usageState === "measured" ? [] : [value.usageState],
            });
          }
          cursor = read.nextCursor;
          if (cursor === null) break;
          if (seenCursors.has(cursor)) throw new Error("decision-cursor-cycle");
          seenCursors.add(cursor);
          if (page === 7) reasons.add("decision-page-limit");
        }
        continue;
      }
      for (const file of source.files) {
        if (bytesLeft <= 0 || linesLeft <= 0) {
          reasons.add("scan-budget");
          break;
        }
        const before = await safeMetadataFile(file);
        const stream = NodeFS.createReadStream(file, { highWaterMark: 16 * 1024, signal });
        let pending = Buffer.alloc(0);
        let oversized = false;
        try {
          for await (const chunk of stream) {
            bytesLeft -= chunk.length;
            if (bytesLeft < 0) {
              reasons.add("scan-budget");
              break;
            }
            pending = Buffer.concat([pending, chunk]);
            while (pending.includes(10)) {
              const end = pending.indexOf(10);
              const line = pending.subarray(0, end);
              pending = pending.subarray(end + 1);
              linesLeft--;
              if (linesLeft < 0) {
                reasons.add("scan-budget");
                break;
              }
              if (oversized || line.length > MAX_LINE) {
                coverage.malformedRecords++;
                oversized = false;
                continue;
              }
              const text = line.toString("utf8");
              const marker = text.indexOf("NTIVE: ");
              if (marker < 0) continue;
              try {
                const envelope = decodeNativeEnvelope(JSON.parse(text.slice(marker + 7)));
                if (envelope.event.kind !== "usage") continue;
                const decoded = decodeAcp(envelope.event.payload);
                if (Option.isNone(decoded)) {
                  coverage.malformedRecords++;
                  continue;
                }
                const value = decoded.value;
                if (value.provider !== source.provider || !isLabel(value.nativeSessionId)) {
                  coverage.malformedRecords++;
                  continue;
                }
                const row = common(source.sourceId, source.provider, envelope.event.id);
                if (value.source === "prompt-response") {
                  if (!isLabel(value.turnId) || !isLabel(value.requestId)) {
                    coverage.malformedRecords++;
                    continue;
                  }
                  const observation = {
                    ...row,
                    id: rowId(
                      source.sourceId,
                      JSON.stringify([
                        value.provider,
                        value.nativeSessionId,
                        value.turnId,
                        value.requestId,
                      ]),
                    ),
                    runId: value.nativeSessionId,
                    turnId: value.turnId,
                    requestId: value.requestId,
                    observedAt: envelope.observedAt,
                    basis:
                      value.tokenBasis === "request"
                        ? ("measured" as const)
                        : value.tokenBasis === "ambiguous"
                          ? ("ambiguous" as const)
                          : ("unknown" as const),
                    counters: {
                      inputTokens: count(value.requestTokens.inputTokens),
                      outputTokens: count(value.requestTokens.outputTokens),
                      cachedInputTokens: count(value.requestTokens.cachedReadTokens),
                      cacheCreationTokens: count(value.requestTokens.cachedWriteTokens),
                      reasoningTokens: count(value.requestTokens.thoughtTokens),
                    },
                    recordedInputTokens: count(value.reportedTokens.inputTokens),
                    recordedOutputTokens: count(value.reportedTokens.outputTokens),
                    issues: [
                      ...value.invalidFields,
                      ...(value.scopeConflict ? ["ambiguous-counter-scope"] : []),
                    ].slice(0, 16),
                  };
                  if (value.receiptConflict || value.acknowledgementMismatch) {
                    rows.delete(observation.id);
                    rejected.add(observation.id);
                    coverage.conflictingRecords++;
                    reasons.add("conflicting-receipt");
                  } else add(observation);
                } else
                  add({
                    ...row,
                    runId: value.nativeSessionId,
                    observedAt: envelope.observedAt,
                    basis: "session",
                    contextUsedTokens: count(value.contextUsedTokens),
                    contextSizeTokens: count(value.contextSizeTokens),
                    reportedCost:
                      value.sessionCost !== null && value.sessionCost.amount >= 0
                        ? { ...value.sessionCost, scope: "session" }
                        : null,
                    issues: [...value.invalidFields, "session-cost-not-request-cost"],
                  });
              } catch {
                coverage.malformedRecords++;
              }
            }
            if (linesLeft < 0) break;
            if (pending.length > MAX_LINE) {
              pending = Buffer.alloc(0);
              oversized = true;
            }
          }
          if (pending.length || oversized) reasons.add("unfinished-record");
        } finally {
          stream.destroy();
        }
        const after = await NodeFSP.stat(file);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
          reasons.add("source-changed-during-read");
        coverage.scannedFiles++;
      }
    } catch {
      reasons.add("source-unavailable");
    }
  }
  if (coverage.malformedRecords) reasons.add("malformed-records");
  const ordered = [...rows.values()].sort(
    (a, b) => (b.observedAt ?? "").localeCompare(a.observedAt ?? "") || a.id.localeCompare(b.id),
  );
  const outputRows = ordered.slice(0, input.limit ?? 50);
  const truncated = outputRows.length !== ordered.length;
  if (truncated) reasons.add("output-row-limit");
  if (!sources.length) reasons.add("sources-unconfigured");
  return {
    ...emptyObservationReport(input, options.readAt),
    rows: outputRows,
    totalRows: ordered.length,
    truncated,
    coverage: {
      ...coverage,
      reasons: [...reasons].slice(0, 16),
      status: sources.length === 0 ? "missing" : reasons.size ? "partial" : "complete",
    },
  };
}

const NativeEnvelope = Schema.Struct({
  observedAt: Schema.String,
  event: Schema.Struct({
    id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    kind: Schema.String,
    payload: Schema.Unknown,
  }),
});
const NullableLabel = Schema.NullOr(Label);
const Counter = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const DecisionPage = Schema.Struct({
  scope: Schema.Literal("retained-actor-decision-attempts"),
  rows: Schema.Array(
    Schema.Struct({
      id: Label,
      batchId: NullableLabel,
      providerResponseId: NullableLabel,
      nativeJobId: NullableLabel,
      model: NullableLabel,
      startedAt: Schema.String,
      inputTokens: Schema.NullOr(Counter),
      outputTokens: Schema.NullOr(Counter),
      reportedCostUsd: Schema.NullOr(
        Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
      ),
      usageState: SourceId,
      taskIds: Schema.Array(Label).check(Schema.isMaxLength(64)),
    }),
  ).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048))),
  partial: Schema.Boolean,
});
const decodeDecisionPage = Schema.decodeUnknownSync(DecisionPage);
const decodeNativeEnvelope = Schema.decodeUnknownSync(NativeEnvelope);
