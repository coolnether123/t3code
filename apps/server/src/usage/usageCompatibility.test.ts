import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { UsageSummaryInput, UsageSummary, UsageReportInput, UsageReport } from "@t3tools/contracts";
import { decodeQuotaHistory } from "./usageQuotaHistory.ts";
import { makeUsageReportCalculation, projectUsageReport } from "./usageReport.ts";

// These payloads match Otis integration/tools/t3-usage-transport.mjs.
const window = { sinceDay: "2026-10-18", untilDay: "2026-10-19", timeZone: "America/Chicago" };
const decodeSummaryInput = Schema.decodeUnknownSync(UsageSummaryInput);

describe("retained usage consumer contract", () => {
  it("accepts the contract 7 summary and exact native-scope requests", () => {
    const request = {
      ...window,
      clientContractVersion: 7,
      resolution: "day",
      groupBy: "model",
      includeQuotaHistory: false,
      includeRepeatedInput: false,
    };
    expect(decodeSummaryInput(request)).toEqual(request);
    const scoped = {
      ...request,
      groupBy: "run",
      runIds: ["synthetic-native-session"],
      sinceTime: "2026-10-18T05:00:00Z",
      untilTime: "2026-10-19T05:00:00Z",
    };
    expect(decodeSummaryInput(scoped)).toEqual(scoped);
  });

  it("keeps the saved Codex quota history in the report response", () => {
    const request = Schema.decodeUnknownSync(UsageReportInput)({
      ...window,
      mode: "quota",
      refresh: false,
    });
    const quotaHistory = decodeQuotaHistory({
      Snapshot: {
        MainLimit: { LimitId: "codex", Window: { DurationMinutes: 10080 } },
        EmergencyResetCount: 2,
        FetchedAt: "2026-10-19T06:00:00Z",
      },
      Samples: [
        {
          ObservedAt: "2026-10-19T06:00:00Z",
          RemainingPercent: 75,
          ResetsAt: "2026-10-23T06:00:00Z",
        },
      ],
    });
    const summary = Schema.decodeUnknownSync(UsageSummary)({
      ...window,
      contractVersion: 7,
      readAt: "2026-10-19T06:00:00Z",
      buckets: [],
      sources: [],
      pricing: {
        status: "unavailable",
        source: "synthetic-rates",
        fetchedAt: null,
        knownModels: 0,
      },
      scanDurationMs: 0,
      quotaHistory,
    });
    const report = projectUsageReport(
      summary,
      request,
      makeUsageReportCalculation(summary.pricing, {}),
    );
    expect(Schema.is(UsageReport)(report)).toBe(true);
    expect(report.mode).toBe("quota");
    const encoded = JSON.stringify(report);
    expect(encoded).toContain("Codex Limits saved history");
    expect(encoded).toContain('"remainingPercent":75');
    expect(encoded).toContain('"bankedResetCount":2');
  });
});
