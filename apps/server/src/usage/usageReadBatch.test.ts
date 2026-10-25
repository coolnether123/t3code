import { describe, expect, it } from "vite-plus/test";
import { UsageDay, type UsageSummary, type UsageSummaryInput } from "@t3tools/contracts";
import { mergeUsageReads, projectUsageRead, usageReadBatchKey } from "./usageReadBatch.ts";

const input: UsageSummaryInput = { sinceDay: UsageDay.make("2026-07-01"), untilDay: UsageDay.make("2026-10-25"), timeZone: "UTC" };
describe("shared usage reads", () => {
  it("combines overlapping quota windows with an unrestricted summary", () => {
    const quota = { ...input, sinceDay: UsageDay.make("2026-10-01"), quotaIntervals: [{ id: "reset", sinceTime: "2026-10-02T00:00:00Z", untilTime: "2026-10-24T00:00:00Z" }] };
    expect(usageReadBatchKey(input)).toBe(usageReadBatchKey(quota));
    expect(mergeUsageReads([quota, input])).toMatchObject({ sinceDay: "2026-07-01", untilDay: "2026-10-25", providers: undefined, quotaIntervals: quota.quotaIntervals });
    expect(usageReadBatchKey({ ...input, timeZone: "America/Chicago" })).not.toBe(usageReadBatchKey(input));
    expect(usageReadBatchKey({ ...input, includeRepeatedInput: true })).not.toBe(usageReadBatchKey(input));
  });
  it("projects a combined scan back to each requested day and provider", () => {
    const fingerprint = { hostId: "test", provider: "codex" as const, resolvedHomePath: "/codex", volumeId: "test" };
    const summary: UsageSummary = { contractVersion: 8, ...input, readAt: "2026-10-25T00:00:00Z", scanDurationMs: 0,
      pricing: { status: "unavailable", source: "fixture", fetchedAt: null, knownModels: 0 },
      buckets: [], sources: [{ fingerprint, status: "ok", scannedFiles: 0, skippedFiles: 0, malformedRecords: 0, distinctSessions: 0, message: null }],
      quotaCosts: ["first", "second"].map((intervalId) => ({ intervalId, fingerprint, costUsd: 10, records: 1, unpricedRecords: 0, complete: true })),
    };
    const projected = projectUsageRead(summary, { ...input, quotaIntervals: [{ id: "second", sinceTime: "2026-10-01T00:00:00Z", untilTime: "2026-10-25T00:00:00Z" }] });
    expect(projected.quotaCosts?.map((row) => row.intervalId)).toEqual(["second"]);
    expect(projectUsageRead(summary, { ...input, providers: ["claude"] }).sources).toEqual([]);
  });
});
