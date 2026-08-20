import { describe, expect, it } from "@effect/vitest";

import { selectTranscriptFilesForScan, type TranscriptFile } from "./usageTranscriptReader.ts";

const file = (path: string, size: number, mtimeMs: number): TranscriptFile => ({
  path,
  size,
  mtimeMs,
});

describe("selectTranscriptFilesForScan", () => {
  it("selects newest cold files within the byte budget", () => {
    const selection = selectTranscriptFilesForScan(
      [file("old", 40, 1), file("new", 60, 3), file("middle", 50, 2)],
      () => false,
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["new", "old"]);
    expect(selection.coldBytes).toBe(100);
    expect(selection.deferredFiles).toBe(1);
    expect(selection.deferredBytes).toBe(50);
  });

  it("always includes warm files without charging the cold budget", () => {
    const selection = selectTranscriptFilesForScan(
      [file("warm", 500, 3), file("cold", 100, 2)],
      ({ path }) => path === "warm",
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["warm", "cold"]);
    expect(selection.coldBytes).toBe(100);
    expect(selection.deferredFiles).toBe(0);
  });

  it("only charges the changed transcript when the rest are warm", () => {
    const selection = selectTranscriptFilesForScan(
      [file("unchanged-a", 500, 3), file("edited", 60, 2), file("unchanged-b", 400, 1)],
      ({ path }) => path !== "edited",
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual([
      "unchanged-a",
      "edited",
      "unchanged-b",
    ]);
    expect(selection.coldBytes).toBe(60);
    expect(selection.deferredFiles).toBe(0);
  });

  it("selects one oversized transcript so it cannot be deferred forever", () => {
    const selection = selectTranscriptFilesForScan(
      [file("oversized", 1_000, 3), file("small", 50, 2)],
      () => false,
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["oversized"]);
    expect(selection.deferredFiles).toBe(1);
    expect(selection.deferredBytes).toBe(50);
    expect(selection.coldBytes).toBe(1_000);
  });

  it("selects a formerly oversized transcript after newer files become warm", () => {
    const selection = selectTranscriptFilesForScan(
      [file("new", 60, 3), file("oversized", 1_000, 2)],
      ({ path }) => path === "new",
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["new", "oversized"]);
    expect(selection.deferredFiles).toBe(0);
  });
});
