// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Exercises the standalone host-side collector against temporary files.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { collectCodexQuotaSample, readCodexRateLimits } from "../../scripts/codex-quota-sampler.ts";
import {
  appendCodexQuotaSample,
  appendCodexQuotaSampleFile,
  codexWeeklyQuotaSample,
  type CodexRateLimitsResponse,
} from "./codexQuotaSampler.ts";

const observedAt = "2026-09-23T15:00:00.000Z";
const response = (usedPercent: number): CodexRateLimitsResponse => ({
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 12, resetsAt: 1_790_000_000, windowDurationMins: 300 },
    secondary: { usedPercent, resetsAt: 1_790_604_800, windowDurationMins: 10_080 },
  },
});

describe("Codex quota sampler", () => {
  it("selects the explicit weekly window rather than the short window", () => {
    expect(codexWeeklyQuotaSample(response(73), observedAt)).toEqual({
      observedAt,
      remainingPercent: 27,
      resetsAt: "2026-09-28T14:13:20.000Z",
    });
  });

  it("records a full balance only when Codex reports zero percent used", () => {
    expect(codexWeeklyQuotaSample(response(0), observedAt)?.remainingPercent).toBe(100);
    expect(codexWeeklyQuotaSample(response(31), observedAt)?.remainingPercent).toBe(69);
  });

  it("does not invent a startup balance when weekly data is absent or invalid", () => {
    expect(codexWeeklyQuotaSample({}, observedAt)).toBeNull();
    expect(
      codexWeeklyQuotaSample(
        {
          rateLimits: { limitId: "codex", secondary: { usedPercent: 0, resetsAt: 1_790_604_800 } },
        },
        observedAt,
      ),
    ).toBeNull();
    expect(codexWeeklyQuotaSample(response(101), observedAt)).toBeNull();
    expect(codexWeeklyQuotaSample(response(0), "bad timestamp")).toBeNull();
  });

  it("appends sanitized samples without overwriting prior account history", () => {
    const first = codexWeeklyQuotaSample(response(80), observedAt)!;
    const initial = appendCodexQuotaSample(null, first);
    const second = codexWeeklyQuotaSample(response(82), "2026-09-23T15:05:00Z")!;
    const appended = appendCodexQuotaSample(initial, second);
    const parsed = JSON.parse(appended) as {
      Snapshot: { MainLimit: { LimitId: string; Window: { DurationMinutes: number } } };
      Samples: { RemainingPercent: number }[];
    };
    expect(parsed.Snapshot.MainLimit).toEqual({
      LimitId: "codex",
      Window: { DurationMinutes: 10_080 },
    });
    expect(parsed.Samples.map((sample) => sample.RemainingPercent)).toEqual([20, 18]);
    expect(appended).not.toContain("email");
  });

  it("preserves saved tracker fields and old observation details", () => {
    const first = codexWeeklyQuotaSample(response(80), observedAt)!;
    const prior = JSON.parse(appendCodexQuotaSample(null, first));
    prior.Snapshot.EmergencyResetCount = 2;
    prior.Snapshot.MainLimit.Origin = "existing tracker";
    prior.Samples[0].Note = "existing observation";
    prior.OtherTrackerData = { retained: true };
    const next = codexWeeklyQuotaSample(response(82), "2026-09-23T15:05:00Z")!;
    const saved = JSON.parse(appendCodexQuotaSample(JSON.stringify(prior), next));
    expect(saved.Snapshot.EmergencyResetCount).toBe(2);
    expect(saved.Snapshot.MainLimit.Origin).toBe("existing tracker");
    expect(saved.Samples[0].Note).toBe("existing observation");
    expect(saved.OtherTrackerData).toEqual({ retained: true });
  });

  it("treats identical timestamps idempotently and rejects conflicts or corrupt history", () => {
    const sample = codexWeeklyQuotaSample(response(80), observedAt)!;
    const initial = appendCodexQuotaSample(null, sample);
    expect(appendCodexQuotaSample(initial, sample)).toBe(initial);
    expect(() =>
      appendCodexQuotaSample(initial, { ...sample, remainingPercent: sample.remainingPercent - 1 }),
    ).toThrow("conflicting quota sample");
    expect(() => appendCodexQuotaSample("{", sample)).toThrow();
    expect(() => appendCodexQuotaSample(null, { ...sample, remainingPercent: 101 })).toThrow(
      "Quota sample is invalid",
    );
  });
});

describe("quota sample file persistence", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("fails cleanly when the Codex executable is missing", async () => {
    await expect(readCodexRateLimits("/nonexistent/t3-codex-sampler")).rejects.toThrow();
  });

  it("writes atomically in the existing read-only import format", async () => {
    directory = await mkdtemp(join(tmpdir(), "t3-quota-sampler-"));
    const filePath = join(directory, "CodexLimits", "state.json");
    const sample = codexWeeklyQuotaSample(response(45), observedAt)!;
    await appendCodexQuotaSampleFile(filePath, sample);
    const saved = JSON.parse(await readFile(filePath, "utf8")) as {
      Samples: { RemainingPercent: number }[];
    };
    expect(saved.Samples).toEqual(
      [{ ...sample, ObservedAt: sample.observedAt }].map((row) => ({
        ObservedAt: row.ObservedAt,
        RemainingPercent: row.remainingPercent,
        ResetsAt: row.resetsAt,
      })),
    );
  });

  it("samples the configured account source and leaves storage untouched on missing weekly data", async () => {
    directory = await mkdtemp(join(tmpdir(), "t3-quota-sampler-"));
    const filePath = join(directory, "state.json");
    await expect(
      collectCodexQuotaSample({
        statePath: filePath,
        now: () => new Date(observedAt),
        readRateLimits: async () => ({}),
      }),
    ).rejects.toThrow("history was left unchanged");
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await collectCodexQuotaSample({
      statePath: filePath,
      now: () => new Date(observedAt),
      readRateLimits: async () => response(45),
    });
    expect(JSON.parse(await readFile(filePath, "utf8")).Samples[0]).toMatchObject({
      RemainingPercent: 55,
    });
  });
});
