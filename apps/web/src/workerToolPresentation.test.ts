import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveActiveWorkerWait,
  deriveWorkerToolCallPresentations,
  parseWorkerToolActivity,
  workerToolDisplayName,
} from "./workerToolPresentation";

const startedAt = "2026-08-23T01:00:00.000Z";

function activity(
  payload: unknown,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`event-${Math.random()}`),
    tone: "tool",
    kind: "tool.updated",
    summary: "Worker tool",
    payload,
    turnId: null,
    createdAt: startedAt,
    ...overrides,
  };
}

describe("T3 Worker tool presentation", () => {
  it("summarizes a successful worker_start with its persisted name and assignment", () => {
    const call = parseWorkerToolActivity(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_start",
            status: "completed",
            result: {
              summary: {
                id: "worker-1",
                displayName: "Repository scout",
                title: "Inspect the provider boundary",
                status: "running",
              },
              assignment: "Inspect the provider boundary",
            },
          },
        },
      }),
    );

    expect(call).toMatchObject({
      action: "Started Worker",
      state: "completed",
      assignment: "Inspect the provider boundary",
      workers: [{ id: "worker-1", name: "Repository scout", status: "running" }],
    });
    expect(workerToolDisplayName(call!)).toBe("Repository scout");
  });

  it("keeps failed and malformed calls honest without throwing", () => {
    const failed = parseWorkerToolActivity(
      activity(
        {
          itemType: "mcp_tool_call",
          status: "failed",
          title: "mcp__t3_code__worker_status",
          data: { toolName: "mcp__t3_code__worker_status", input: { workerId: "worker-2" } },
        },
        { kind: "tool.completed", tone: "error" },
      ),
    );
    expect(failed).toMatchObject({ action: "Checked Worker status", state: "failed" });
    expect(parseWorkerToolActivity(activity({ itemType: "mcp_tool_call", data: null }))).toBeNull();
    expect(
      parseWorkerToolActivity(activity({ itemType: "mcp_tool_call", data: { item: { tool: 3 } } })),
    ).toBeNull();
  });

  it("reads the legacy Claude-shaped toolName/input/result record", () => {
    const call = parseWorkerToolActivity(
      activity(
        {
          itemType: "mcp_tool_call",
          data: {
            toolName: "mcp__t3_code__worker_status",
            input: { workerId: "worker-legacy" },
            result: {
              status: "completed",
              summary: { id: "worker-legacy", title: "Legacy check" },
            },
          },
          title: "mcp__t3_code__worker_status",
        },
        { kind: "tool.completed" },
      ),
    );
    expect(call).toMatchObject({
      workerIds: ["worker-legacy"],
      workers: [{ id: "worker-legacy", name: "Legacy check" }],
      state: "completed",
    });
  });

  it("resolves singular worker_observe arguments through prior Worker identity", () => {
    const started = activity(
      {
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_start",
            status: "completed",
            result: { summary: { id: "worker-1", displayName: "Scout", title: "Scan files" } },
          },
        },
      },
      { kind: "tool.completed", sequence: 1 },
    );
    const observed = activity(
      {
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_observe",
            status: "completed",
            arguments: { workerId: "worker-1" },
            result: { workerId: "worker-1", summary: "Still working" },
          },
        },
      },
      { kind: "tool.completed", sequence: 2 },
    );

    const call = deriveWorkerToolCallPresentations([started, observed]).find(
      (candidate) => candidate.toolName === "worker_observe",
    );
    expect(call).toMatchObject({
      workerIds: ["worker-1"],
      workers: [{ id: "worker-1", name: "Scout" }],
    });
    expect(workerToolDisplayName(call!)).toBe("Scout");
  });

  it("shows an active wait only while the real tool lifecycle is in progress", () => {
    const waitStarted = activity(
      {
        itemType: "mcp_tool_call",
        status: "inProgress",
        data: {
          toolCallId: "wait-1",
          item: {
            tool: "worker_wait",
            status: "inProgress",
            arguments: { workerIds: ["worker-1"], timeoutMillis: 60_000, mode: "anyRelevantEvent" },
          },
        },
        title: "worker_wait",
      },
      { sequence: 2 },
    );
    const started = activity(
      {
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_start",
            status: "completed",
            result: { summary: { id: "worker-1", displayName: "Scout", title: "Scan files" } },
          },
        },
        title: "worker_start",
      },
      { kind: "tool.completed", sequence: 1 },
    );
    const active = deriveActiveWorkerWait([waitStarted, started], Date.parse(startedAt) + 4_000);
    expect(active).toMatchObject({
      toolName: "worker_wait",
      workers: [{ name: "Scout" }],
      timeoutMillis: 60_000,
      latestEvent: "Waiting for 4s",
    });

    const finished = activity(
      {
        itemType: "mcp_tool_call",
        status: "completed",
        data: {
          toolCallId: "wait-1",
          item: {
            tool: "worker_wait",
            status: "completed",
            result: { status: "woken", reason: "completed" },
          },
        },
        title: "worker_wait",
      },
      { kind: "tool.completed", sequence: 3, createdAt: "2026-08-23T01:00:05.000Z" },
    );
    expect(deriveActiveWorkerWait([started, waitStarted, finished])).toBeNull();
  });

  it("does not throw on a malformed wait timestamp", () => {
    const waitStarted = activity(
      {
        itemType: "mcp_tool_call",
        status: "inProgress",
        data: {
          toolCallId: "wait-malformed",
          item: {
            tool: "worker_wait",
            status: "inProgress",
            arguments: { workerIds: ["worker-1"], timeoutMillis: 60_000 },
          },
        },
      },
      { createdAt: "not-a-date" },
    );

    expect(() => deriveActiveWorkerWait([waitStarted])).not.toThrow();
    const activeWait = deriveActiveWorkerWait([waitStarted]);
    expect(activeWait).toMatchObject({ latestEvent: "Wait started" });
    expect(activeWait).not.toHaveProperty("deadlineAt");
  });

  it("expires an orphaned in-progress wait at its own deadline", () => {
    const waitStarted = activity({
      itemType: "mcp_tool_call",
      status: "inProgress",
      data: {
        toolCallId: "wait-orphaned",
        item: {
          tool: "worker_wait",
          status: "inProgress",
          arguments: { workerIds: ["worker-1"], timeoutMillis: 1_000 },
        },
      },
    });

    expect(deriveActiveWorkerWait([waitStarted], Date.parse(startedAt) + 999)).not.toBeNull();
    expect(deriveActiveWorkerWait([waitStarted], Date.parse(startedAt) + 1_000)).toBeNull();
  });
});
