import type { WorkerId, WorkerMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parseWorkerContextInputs,
  resolveSelectedWorkerId,
  workerCardSummary,
} from "./WorkersPanel";
import workersPanelSource from "./WorkersPanel.tsx?raw";

const workerId = (value: string) => value as WorkerId;

describe("WorkersPanel context mapping", () => {
  it("maps explicit paths, ranges, symbols, and snippets without parent history", () => {
    const context = parseWorkerContextInputs({
      note: "Review only these inputs.",
      references: [
        "apps/server/src/worker/WorkerStore.ts:10-40#WorkerStore",
        "docs/internals/workers.md#Recovery",
        "C:\\repo\\worker.ts:7-9",
      ].join("\n"),
      snippets: "first selected snippet\nsecond selected snippet",
    });

    expect(context).toEqual({
      note: "Review only these inputs.",
      references: [
        {
          path: "apps/server/src/worker/WorkerStore.ts",
          lineStart: 10,
          lineEnd: 40,
          symbol: "WorkerStore",
        },
        { path: "docs/internals/workers.md", symbol: "Recovery" },
        { path: "C:\\repo\\worker.ts", lineStart: 7, lineEnd: 9 },
      ],
      snippets: ["first selected snippet", "second selected snippet"],
    });
    expect(context).not.toHaveProperty("transcript");
    expect(context).not.toHaveProperty("history");
  });

  it("rejects reversed ranges and empty symbols", () => {
    expect(() =>
      parseWorkerContextInputs({ note: "", references: "file.ts:40-10", snippets: "" }),
    ).toThrow("invalid line range");
    expect(() =>
      parseWorkerContextInputs({ note: "", references: "file.ts#", snippets: "" }),
    ).toThrow("empty symbol");
  });
});

describe("WorkersPanel selection", () => {
  const workers = [{ id: workerId("worker-1") }, { id: workerId("worker-2") }];

  it("selects the first Worker after load and realigns when the selection disappears", () => {
    expect(resolveSelectedWorkerId(null, workers)).toBe(workerId("worker-1"));
    expect(resolveSelectedWorkerId(workerId("worker-2"), workers)).toBe(workerId("worker-2"));
    expect(resolveSelectedWorkerId(workerId("removed"), workers)).toBe(workerId("worker-1"));
    expect(resolveSelectedWorkerId(workerId("worker-1"), [])).toBeNull();
  });
});

describe("WorkersPanel card summary", () => {
  it("shows the persisted Worker handoff when no observer report exists", () => {
    expect(
      workerCardSummary({
        latestDirectMessage: {
          body: "WORKER READY",
          createdAt: "2026-08-22T16:00:00.000Z",
        } as WorkerMessage,
      }),
    ).toBe("WORKER READY");
  });
});

describe("WorkersPanel presentation boundary", () => {
  it("stacks at mobile width and uses overflow-safe touch controls", () => {
    expect(workersPanelSource).toContain("max-[680px]:grid-cols-1");
    expect(workersPanelSource).toContain("overflow-x-hidden");
    expect(workersPanelSource).toContain("min-h-11");
    expect(workersPanelSource).toContain("min-w-0");
  });

  it("renders direct messages without exposing provider internals or reasoning", () => {
    expect(workersPanelSource).toContain("detail.messages.map");
    expect(workersPanelSource).not.toContain("providerEvents");
    expect(workersPanelSource).not.toContain("chain-of-thought");
  });
});
