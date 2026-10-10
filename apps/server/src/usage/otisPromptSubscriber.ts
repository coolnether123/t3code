import * as NodeUtil from "node:util";
import {
  OtisPromptReport,
  type UsageReportInput,
  type UsageReportPrompts,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { normalizePromptKeyword } from "./promptWords.ts";
import { promptUsageTimeBounds } from "./usagePromptReport.ts";

const decodeReport = Schema.decodeUnknownSync(OtisPromptReport);

export async function readOtisPromptReport(
  input: UsageReportInput,
  env = process.env,
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<OtisPromptReport> {
  if (env.T3_OTIS_USAGE_MODE === "off" || !env.T3_OTIS_USAGE_ORIGIN || !env.T3_OTIS_USAGE_TOKEN)
    throw new Error("otis-unconfigured");
  const origin = new URL(env.T3_OTIS_USAGE_ORIGIN);
  if (
    origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error("otis-invalid-configuration");
  const sourceId = env.T3_OTIS_USAGE_SOURCE_ID ?? "t3-local";
  const response = await fetchImpl(new URL("/api/v1/usage-analytics/report", origin), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: {
      Authorization: `Bearer ${env.T3_OTIS_USAGE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: 1,
      sourceId,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      timeZone: input.timeZone,
      ...(input.sinceTime === undefined
        ? {}
        : {
            sinceTime: DateTime.formatIso(DateTime.makeUnsafe(input.sinceTime)),
            untilTime: DateTime.formatIso(DateTime.makeUnsafe(input.untilTime!)),
          }),
      ...(input.keyword === undefined ? {} : { keyword: input.keyword }),
      limit: input.limit ?? 20,
    }),
  });
  if (!response.ok || !response.body) throw new Error("otis-unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error("otis-response-limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const report = decodeReport(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const bounds = promptUsageTimeBounds(input);
  if (
    report.sourceId !== sourceId ||
    report.window.sinceDay !== input.sinceDay ||
    report.window.untilDay !== input.untilDay ||
    report.window.timeZone !== input.timeZone ||
    report.window.sinceTime !== bounds.sinceTime ||
    report.window.untilTime !== bounds.untilTime ||
    report.words.length > (input.limit ?? 20) ||
    !Number.isFinite(Date.parse(report.readAt)) ||
    (report.freshness.sourceObservedAt !== null &&
      !Number.isFinite(Date.parse(report.freshness.sourceObservedAt))) ||
    (input.keyword !== undefined &&
      report.totals !== null &&
      report.keyword?.word !== normalizePromptKeyword(input.keyword))
  )
    throw new Error("otis-contract-scope");
  if (
    (report.status === "available" &&
      (report.coverage.status !== "complete" ||
        report.totals === null ||
        report.coverage.reasons.length > 0)) ||
    (report.status === "unavailable" &&
      (report.totals !== null || report.coverage.status !== "missing"))
  )
    throw new Error("otis-contract-status");
  return report;
}

export function usableOtisReport(
  report: OtisPromptReport | null,
): report is OtisPromptReport & { totals: NonNullable<OtisPromptReport["totals"]> } {
  return (
    report !== null &&
    report.status === "available" &&
    report.coverage.status === "complete" &&
    report.freshness.status === "current" &&
    report.totals !== null &&
    report.coverage.examinedMessages !== null &&
    report.coverage.countedMessages !== null &&
    report.coverage.truncatedMessages !== null &&
    report.countedDistinctWords !== null &&
    report.wordsTruncated !== null
  );
}

export function selectPromptReport(
  input: UsageReportInput,
  otis: OtisPromptReport | null,
  local?: UsageReportPrompts,
): UsageReportPrompts {
  const fields = [
    "totals",
    "words",
    "daily",
    "keyword",
    "countedDistinctWords",
    "wordsTruncated",
  ] as const;
  // Both sides are JSON contract values. Local rows come from SQLite with null prototypes,
  // so compare their JSON form instead of object identity or prototype.
  const sameValue = (left: unknown, right: unknown) =>
    NodeUtil.isDeepStrictEqual(
      left === undefined ? undefined : JSON.parse(JSON.stringify(left)),
      right === undefined ? undefined : JSON.parse(JSON.stringify(right)),
    );
  const differences: string[] =
    local && otis ? fields.filter((field) => !sameValue(otis[field], local[field])) : [];
  if (local && otis)
    for (const field of [
      "status",
      "examinedMessages",
      "countedMessages",
      "truncatedMessages",
      "reasons",
    ] as const)
      if (!sameValue(otis.coverage[field], local.coverage[field]))
        differences.push(`coverage.${field}`);
  const parity = !local
    ? "cutover-verified"
    : !otis
      ? "unavailable"
      : differences.length
        ? "mismatch"
        : "matched";
  if (usableOtisReport(otis) && (parity === "matched" || parity === "cutover-verified"))
    return {
      contractVersion: 1,
      mode: "prompts",
      readAt: otis.readAt,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      timeZone: input.timeZone,
      scope: "t3UserMessages",
      totals: otis.totals,
      words: otis.words,
      daily: otis.daily,
      coverage: {
        status: "complete",
        examinedMessages: otis.coverage.examinedMessages!,
        countedMessages: otis.coverage.countedMessages!,
        truncatedMessages: otis.coverage.truncatedMessages!,
        reasons: [],
      },
      countedDistinctWords: otis.countedDistinctWords!,
      wordsTruncated: otis.wordsTruncated!,
      ...(otis.keyword === undefined ? {} : { keyword: otis.keyword }),
      countingPolicy:
        "Otis index unicode-runs-nfkc-v1. Stored T3 user-message IDs only. Attachment contents and agent replies are excluded. Words are not tokens. Common English words and digit-bearing runs are omitted from rankings, not keyword counts. Copies with different IDs count separately.",
      analytics: {
        authority: "Otis",
        freshness: otis.freshness.status,
        sourceObservedAt: otis.freshness.sourceObservedAt,
        parity,
        differences,
      },
    };
  if (!local) throw new Error("local-fallback-required");
  return {
    ...local,
    analytics: {
      authority: "T3-fallback",
      freshness: otis?.freshness.status ?? "unavailable",
      sourceObservedAt: otis?.freshness.sourceObservedAt ?? null,
      parity,
      differences,
      reason: !otis
        ? "otis-unavailable"
        : otis.coverage.status !== "complete"
          ? "otis-index-partial"
          : otis.freshness.status !== "current"
            ? "otis-stale"
            : "otis-parity-mismatch",
    },
  };
}
