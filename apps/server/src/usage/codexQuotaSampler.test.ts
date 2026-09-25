// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Exercises the standalone host-side collector against temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  collectCodexQuotaSample,
  readCodexRateLimits,
  requestCodexRpc,
} from "../../scripts/codex-quota-sampler.ts";
import {
  appendCodexQuotaSample,
  appendCodexQuotaSampleFile,
  codexWeeklyQuotaSample,
  resolveCodexQuotaRequestTimeoutMs,
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

const fullHistory = () => {
  const start = Date.parse("2026-09-01T00:00:00Z");
  return JSON.stringify({
    Snapshot: {
      MainLimit: { LimitId: "codex", Window: { DurationMinutes: 10_080 } },
      EmergencyResetCount: 3,
    },
    Samples: Array.from({ length: 5_000 }, (_, index) => ({
      ObservedAt: new Date(start + index * 300_000).toISOString(),
      RemainingPercent: 80 - (index % 80),
      ResetsAt: "2026-10-01T00:00:00Z",
    })),
  });
};

const sampleAfterFullHistory = {
  observedAt: new Date(Date.parse("2026-09-01T00:00:00Z") + 5_000 * 300_000).toISOString(),
  remainingPercent: 75,
  resetsAt: "2026-10-01T00:00:00Z",
};

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

  it("allows slow Codex initialization and accepts a bounded timeout override", async () => {
    expect(resolveCodexQuotaRequestTimeoutMs()).toBe(30_000);
    expect(resolveCodexQuotaRequestTimeoutMs("45000")).toBe(45_000);
    expect(resolveCodexQuotaRequestTimeoutMs("500")).toBe(30_000);
    expect(resolveCodexQuotaRequestTimeoutMs("not-a-number")).toBe(30_000);

    vi.useFakeTimers();
    try {
      const child = Object.assign(new NodeEvents.EventEmitter(), {
        stdin: new NodeStream.PassThrough(),
        stdout: new NodeStream.PassThrough(),
        exitCode: null,
      });
      let settled = false;
      let rejection: unknown;
      const request = requestCodexRpc(
        child as unknown as NodeChildProcess.ChildProcessWithoutNullStreams,
        1,
        "initialize",
        {},
        30_000,
      ).then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          rejection = error;
        },
      );

      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await request;
      expect(settled).toBe(true);
      expect(rejection).toMatchObject({
        message: "Codex did not answer initialize within 30000 ms.",
      });
    } finally {
      vi.useRealTimers();
    }
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
    if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("fails cleanly when the Codex executable is missing", async () => {
    await expect(readCodexRateLimits("/nonexistent/t3-codex-sampler")).rejects.toThrow();
  });

  it("writes atomically in the existing read-only import format", async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-quota-sampler-"));
    const filePath = NodePath.join(directory, "CodexLimits", "state.json");
    const sample = codexWeeklyQuotaSample(response(45), observedAt)!;
    await appendCodexQuotaSampleFile(filePath, sample);
    const saved = JSON.parse(await NodeFSP.readFile(filePath, "utf8")) as {
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

  it("archives old observations before rollover and keeps the active history readable", async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-quota-sampler-"));
    const filePath = NodePath.join(directory, "state.json");
    const initial = fullHistory();
    await NodeFSP.writeFile(filePath, initial);
    await appendCodexQuotaSampleFile(filePath, sampleAfterFullHistory);

    const active = JSON.parse(await NodeFSP.readFile(filePath, "utf8"));
    const archives = await NodeFSP.readdir(`${filePath}.archive`);
    expect(archives).toHaveLength(1);
    const archived = JSON.parse(
      await NodeFSP.readFile(NodePath.join(`${filePath}.archive`, archives[0]!), "utf8"),
    );
    expect(archived.Samples).toEqual(JSON.parse(initial).Samples.slice(0, 1_000));
    expect(active.Samples).toEqual([
      ...JSON.parse(initial).Samples.slice(1_000),
      {
        ObservedAt: sampleAfterFullHistory.observedAt,
        RemainingPercent: sampleAfterFullHistory.remainingPercent,
        ResetsAt: new Date(sampleAfterFullHistory.resetsAt).toISOString(),
      },
    ]);
    expect(active.Snapshot.EmergencyResetCount).toBe(3);

    // A crash after archiving but before replacing state.json must not duplicate archives.
    await NodeFSP.writeFile(filePath, initial);
    await appendCodexQuotaSampleFile(filePath, sampleAfterFullHistory);
    expect(await NodeFSP.readdir(`${filePath}.archive`)).toEqual(archives);
  });

  it("does not replace a full history when its archive cannot be written", async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-quota-sampler-"));
    const filePath = NodePath.join(directory, "state.json");
    const initial = fullHistory();
    await NodeFSP.writeFile(filePath, initial);
    await NodeFSP.writeFile(`${filePath}.archive`, "occupied");
    await expect(appendCodexQuotaSampleFile(filePath, sampleAfterFullHistory)).rejects.toThrow();
    expect(await NodeFSP.readFile(filePath, "utf8")).toBe(initial);
  });

  it("does not archive a full history for an invalid new reading", async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-quota-sampler-"));
    const filePath = NodePath.join(directory, "state.json");
    const initial = fullHistory();
    await NodeFSP.writeFile(filePath, initial);
    await expect(
      appendCodexQuotaSampleFile(filePath, { ...sampleAfterFullHistory, remainingPercent: 101 }),
    ).rejects.toThrow("Quota sample is invalid");
    expect(await NodeFSP.readFile(filePath, "utf8")).toBe(initial);
    await expect(NodeFSP.readdir(`${filePath}.archive`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("samples the configured account source and leaves storage untouched on missing weekly data", async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-quota-sampler-"));
    const filePath = NodePath.join(directory, "state.json");
    await expect(
      collectCodexQuotaSample({
        statePath: filePath,
        now: () => new Date(observedAt),
        readRateLimits: async () => ({}),
      }),
    ).rejects.toThrow("history was left unchanged");
    await expect(NodeFSP.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await collectCodexQuotaSample({
      statePath: filePath,
      now: () => new Date(observedAt),
      readRateLimits: async () => response(45),
    });
    expect(JSON.parse(await NodeFSP.readFile(filePath, "utf8")).Samples[0]).toMatchObject({
      RemainingPercent: 55,
    });
  });
});
