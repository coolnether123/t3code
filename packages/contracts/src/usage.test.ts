import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { UsageReportInput, UsageSourceFingerprint, UsageSummaryInput } from "./usage.ts";

const decode = Schema.decodeUnknownSync(UsageSummaryInput);
const base = {
  timeZone: "UTC",
  sinceDay: "2026-08-01",
  untilDay: "2026-08-02",
};

it("accepts missing Grok source fingerprints reported by older Mac servers", () => {
  expect(
    Schema.decodeUnknownSync(UsageSourceFingerprint)({
      hostId: "millie",
      provider: "grok",
      resolvedHomePath: "/Users/millie/.grok",
      volumeId: "",
    }).provider,
  ).toBe("grok");
});

describe("UsageSummaryInput", () => {
  it("accepts bounded provider, native session, and native turn selection", () => {
    expect(
      decode({
        ...base,
        providers: ["codex"],
        sessionIds: ["native-session"],
        turnIds: ["native-turn"],
        groupBy: "turn",
        includeRepeatedInput: true,
      }),
    ).toMatchObject({
      providers: ["codex"],
      sessionIds: ["native-session"],
      turnIds: ["native-turn"],
      groupBy: "turn",
      includeRepeatedInput: true,
    });
  });

  it("rejects empty provider selections and oversized native-ID queries", () => {
    expect(() => decode({ ...base, providers: [] })).toThrow();
    expect(() =>
      decode({ ...base, sessionIds: Array.from({ length: 129 }, (_, index) => `s-${index}`) }),
    ).toThrow();
    expect(() => decode({ ...base, turnIds: ["t".repeat(513)] })).toThrow();
    expect(() => decode({ ...base, runIds: ["r".repeat(513)] })).toThrow();
  });

  it("supports exact native run-ID selection", () => {
    expect(decode({ ...base, groupBy: "run", runIds: ["native-run"] })).toMatchObject({
      groupBy: "run",
      runIds: ["native-run"],
    });
  });
});

describe("UsageReportInput", () => {
  const reportDecode = Schema.decodeUnknownSync(UsageReportInput);

  it("accepts each bounded projection mode", () => {
    expect(reportDecode({ ...base, mode: "overview", limit: 1 })).toMatchObject({
      mode: "overview",
      limit: 1,
    });
    expect(
      reportDecode({
        ...base,
        mode: "series",
        resolution: "hour",
        sinceTime: "2026-08-01T00:00:00Z",
        untilTime: "2026-08-01T01:00:00Z",
      }),
    ).toMatchObject({ mode: "series", resolution: "hour" });
    expect(reportDecode({ ...base, mode: "quota", quotaIntervals: [] })).toMatchObject({
      mode: "quota",
      quotaIntervals: [],
    });
    expect(reportDecode({ ...base, mode: "runs", runIds: ["native-session"] })).toMatchObject({
      mode: "runs",
      runIds: ["native-session"],
    });
    expect(reportDecode({ ...base, mode: "runs", threadIds: ["t3-thread"] })).toMatchObject({
      threadIds: ["t3-thread"],
    });
  });

  it("rejects an unbounded report row request", () => {
    expect(() => reportDecode({ ...base, mode: "models", limit: 513 })).toThrow();
    expect(() => reportDecode({ ...base, mode: "models", limit: 0 })).toThrow();
    expect(() => reportDecode({ ...base, mode: "runs", runIds: [] })).toThrow();
    expect(() =>
      reportDecode({
        ...base,
        mode: "runs",
        runIds: Array.from({ length: 33 }, (_, index) => `run-${index}`),
      }),
    ).toThrow();
    expect(() => reportDecode({ ...base, mode: "runs", runIds: ["r".repeat(513)] })).toThrow();
    expect(() => reportDecode({ ...base, mode: "runs", threadIds: [] })).toThrow();
    expect(() =>
      reportDecode({ ...base, mode: "runs", threadIds: Array(33).fill("thread") }),
    ).toThrow();
    expect(() => reportDecode({ ...base, mode: "runs", threadIds: ["t".repeat(513)] })).toThrow();
  });
});
