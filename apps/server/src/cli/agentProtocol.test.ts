import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentProviderStatus,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  OrchestrationV2RuntimeRequest,
  type EnvironmentProviderSnapshotResult,
} from "@t3tools/contracts";
import {
  AGENT_OUTPUT_MAX_BYTES,
  AGENT_RECEIPT_METADATA_MAX_BYTES,
  AGENT_REQUEST_MAX_BYTES,
  compactAgentProviders,
  compactAgentSnapshot,
  decodeAgentAction,
  decodeAgentRequest,
  encodeAgentOutput,
  validateAgentAction,
  validateAgentOrigin,
  validateAgentReceiptMetadata,
} from "./agentProtocol.ts";

const decodeEnvironmentProviderStatus = Schema.decodeUnknownSync(EnvironmentProviderStatus);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const now = "2026-08-31T04:00:00.000Z";
const runtime = { pid: 123, startedAt: now };
const identity = { environmentId: "env-a", runtime };
const thread = {
  id: "thread-a",
  projectId: "project-a",
  title: "Scratch",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "thread-a", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
};
const run = {
  id: "run-a",
  threadId: "thread-a",
  ordinal: 1,
  providerInstanceId: "codex",
  modelSelection: thread.modelSelection,
  providerThreadId: null,
  userMessageId: "message-a",
  rootNodeId: null,
  activeAttemptId: null,
  status: "running",
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const decodeDetail = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot),
);
const detail = decodeDetail({
  snapshotSequence: 12,
  historyCursor: "older",
  hasMoreHistory: true,
  projection: {
    thread,
    runs: [run],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  },
});
const shellThread = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadShell))({
  ...thread,
  latestRunId: "run-a",
  activeRunId: "run-a",
  status: "running",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: now,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  settledOverride: null,
  settledAt: null,
});
const shell = Schema.decodeUnknownSync(OrchestrationV2ShellSnapshot)({
  schemaVersion: 2,
  snapshotSequence: 12,
  projects: [],
  threads: [shellThread],
  archivedThreads: [],
});
const envelope = (command: unknown) => encodeJson({ ...identity, command });
it("binds voice coverage to the observed runtime and preserves legacy absence", () => {
  expect(compactAgentSnapshot(identity, shell)).not.toHaveProperty("voice");
  expect(
    compactAgentSnapshot(identity, {
      ...shell,
      voice: { coverage: "complete", count: 0, openCalls: [], activeSessions: [], observedAt: now },
    }).voice,
  ).toEqual({
    coverage: "complete",
    count: 0,
    openCalls: [],
    activeSessions: [],
    observedAt: now,
    runtime: identity.runtime,
  });
});
const interrupt = {
  type: "run.interrupt",
  commandId: "command-a",
  threadId: "thread-a",
  runId: "run-a",
};
const request = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2RuntimeRequest))({
  id: "request-a",
  nodeId: "node-a",
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input",
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: now,
  resolvedAt: null,
});
const item = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2TurnItem))({
  id: "item-a",
  threadId: "thread-a",
  runId: "run-a",
  nodeId: "node-a",
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "running",
  title: "Pick",
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  type: "user_input_request",
  requestId: "request-a",
  questions: [
    {
      id: "q-a",
      header: "Pick",
      question: "Pick one",
      options: [{ label: "One", description: "First" }],
      isOther: false,
      isSecret: false,
    },
  ],
});

describe("agent action boundary", () => {
  it("requires the current environment, runtime and active run before interrupting", () => {
    const action = decodeAgentAction(envelope(interrupt));
    expect(action.command).toEqual(interrupt);
    expect(() => validateAgentAction(action, identity, shell, detail)).not.toThrow();
    expect(() => decodeAgentAction(envelope({ ...interrupt, runId: undefined }))).toThrow();
    expect(() =>
      validateAgentAction(action, { ...identity, environmentId: "env-b" }, shell, detail),
    ).toThrow();
    expect(() =>
      validateAgentAction(
        action,
        { ...identity, runtime: { ...runtime, pid: 124 } },
        shell,
        detail,
      ),
    ).toThrow();
    expect(() =>
      validateAgentAction(
        decodeAgentAction(envelope({ ...interrupt, runId: "old" })),
        identity,
        shell,
        detail,
      ),
    ).toThrow();
  });
  it("restores an archived thread from shell evidence without loading its transcript", () => {
    const action = decodeAgentAction(
      envelope({
        type: "thread.unarchive",
        commandId: "restore-a",
        threadId: "thread-a",
      }),
    );
    const archived = { ...shellThread, archivedAt: DateTime.makeUnsafe(now) };
    expect(() =>
      validateAgentAction(action, identity, { ...shell, threads: [], archivedThreads: [archived] }),
    ).not.toThrow();
    expect(() => validateAgentAction(action, identity, shell)).toThrow("Archived thread");
    expect(() =>
      validateAgentAction(action, identity, { ...shell, archivedThreads: [shellThread] }),
    ).toThrow("Archived thread");
    expect(() =>
      validateAgentAction(action, identity, {
        ...shell,
        archivedThreads: [{ ...archived, deletedAt: DateTime.makeUnsafe(now) }],
      }),
    ).toThrow("Archived thread");
    expect(() =>
      validateAgentAction(
        action,
        { ...identity, environmentId: "elsewhere" },
        { ...shell, archivedThreads: [archived] },
      ),
    ).toThrow("Environment");
  });
  it("rejects unknown fields, oversized input and destructive commands", () => {
    expect(() => decodeAgentAction(envelope({ ...interrupt, typo: true }))).toThrow();
    expect(() => decodeAgentAction(" ".repeat(262145))).toThrow();
    expect(() =>
      decodeAgentAction(envelope({ type: "thread.delete", commandId: "x", threadId: "thread-a" })),
    ).toThrow();
  });
  it("requires explicit action confirmation in a single bounded request", () => {
    expect(decodeAgentRequest('{"kind":"capabilities"}')).toEqual({ kind: "capabilities" });
    expect(
      decodeAgentRequest(
        encodeJson({ kind: "act", confirm: true, ...identity, command: interrupt }),
      ),
    ).toMatchObject({ kind: "act" });
    for (const json of [
      "{invalid",
      '{"kind":"snapshot"} {}',
      '{"kind":"unknown"}',
      encodeJson({ kind: "capabilities", extra: true }),
      encodeJson({ kind: "act", action: { ...identity, command: interrupt } }),
      " ".repeat(AGENT_REQUEST_MAX_BYTES + 1),
    ]) {
      expect(() => decodeAgentRequest(json)).toThrow();
    }
  });
  it("validates history and list bounds", () => {
    expect(decodeAgentRequest('{"kind":"snapshot"}')).toEqual({
      kind: "snapshot",
      turnLimit: 3,
      offset: 0,
    });
    for (const turnLimit of [0, 6, 1.5, "3"])
      expect(() => decodeAgentRequest(encodeJson({ kind: "snapshot", turnLimit }))).toThrow();
    for (const offset of [-1, 1.5, 1000001])
      expect(() => decodeAgentRequest(encodeJson({ kind: "snapshot", offset }))).toThrow();
  });
  it("does not expose session-wide approval or checkout mutation", () => {
    expect(() =>
      decodeAgentAction(
        envelope({
          type: "runtime-request.respond",
          commandId: "c",
          threadId: "thread-a",
          requestId: "request-a",
          decision: "acceptForSession",
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeAgentAction(
        envelope({
          type: "thread.metadata.update",
          commandId: "c",
          threadId: "thread-a",
          worktreePath: "/other",
        }),
      ),
    ).toThrow();
  });
  it("requires pending request evidence before a response", () => {
    const action = decodeAgentAction(
      envelope({
        type: "runtime-request.respond",
        commandId: "c",
        threadId: "thread-a",
        requestId: "request-a",
        answers: { "q-a": "One" },
      }),
    );
    expect(() => validateAgentAction(action, identity, shell, detail)).toThrow();
    expect(() =>
      validateAgentAction(action, identity, shell, {
        ...detail,
        projection: { ...detail.projection, runtimeRequests: [request] },
      }),
    ).not.toThrow();
  });
  it("allows only bare loopback origins", () => {
    expect(validateAgentOrigin("http://127.0.0.1:8282")).toBe("http://127.0.0.1:8282");
    for (const url of [
      "http://example.com",
      "http://user:secret@localhost:8282",
      "http://localhost:8282/path",
      "http://localhost:8282?token=x",
    ])
      expect(() => validateAgentOrigin(url)).toThrow();
  });
});

describe("agent snapshot", () => {
  it("keeps pending request details outside the bounded activity tail", () => {
    const selected = {
      ...detail,
      projection: {
        ...detail.projection,
        runtimeRequests: [request],
        turnItems: [
          item,
          ...Array.from({ length: 30 }, (_, i) => ({
            ...item,
            id: item.id,
            requestId: `other-${i}` as typeof request.id,
          })),
        ],
      },
    };
    const snapshot = compactAgentSnapshot(identity, shell, selected);
    expect(snapshot.requests).toMatchObject([
      { id: "request-a", detail: { questions: [{ id: "q-a", options: [{ label: "One" }] }] } },
    ]);
    expect(snapshot.activity).toHaveLength(20);
    expect(snapshot.historyCursor).toBe("older");
    expect(snapshot.hasMoreHistory).toBe(true);
    const closed = compactAgentSnapshot(identity, shell, {
      ...selected,
      projection: { ...selected.projection, runtimeRequests: [{ ...request, status: "resolved" }] },
    });
    expect(closed.requests).toEqual([]);
  });
  it("pages lists without skipping entries", () => {
    const many = {
      ...shell,
      threads: Array.from({ length: 52 }, (_, i) => ({
        ...shellThread,
        id: `thread-${i}` as typeof shellThread.id,
      })),
    };
    expect(compactAgentSnapshot(identity, many).listPage.nextOffset).toBe(25);
    expect(compactAgentSnapshot(identity, many, undefined, 25).threads[0]?.id).toBe("thread-25");
    expect(compactAgentSnapshot(identity, many, undefined, 25).listPage.nextOffset).toBe(50);
    expect(compactAgentSnapshot(identity, many, undefined, 50).listPage.nextOffset).toBeNull();
  });
  it("preserves accepted and uncertain receipts when readback is oversized", () => {
    const metadata = {
      ...identity,
      commandId: "i".repeat(AGENT_RECEIPT_METADATA_MAX_BYTES - 1000),
      commandType: "message.dispatch",
    };
    expect(() => validateAgentReceiptMetadata(metadata)).not.toThrow();
    expect(() =>
      validateAgentReceiptMetadata({ ...metadata, environmentId: "?".repeat(40000) }),
    ).toThrow();
    for (const status of ["accepted", "unknown"]) {
      const output = encodeAgentOutput({
        ...metadata,
        status,
        sequence: 13,
        readback: "x".repeat(AGENT_OUTPUT_MAX_BYTES),
      });
      expect(output).toContain(`"status":"${status}"`);
      expect(output).toContain('"sequence":13');
      expect(output).toContain("Readback omitted");
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(AGENT_OUTPUT_MAX_BYTES);
    }
  });
});

describe("agent provider snapshot", () => {
  it("keeps provider output small and reports omitted instances", () => {
    const provider = (index: number) =>
      decodeEnvironmentProviderStatus({
        instanceId: `codex_work_${index}`,
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        status: "warning",
        availability: "available",
        message: "x".repeat(2000),
        messageTruncated: true,
        version: "1.0.0",
        auth: { status: "authenticated", type: "oauth", label: "Signed in" },
        modelCount: 12,
        skillCount: 4,
        desktopBacked: true,
      });
    const response = {
      providers: Array.from({ length: 32 }, (_, index) => provider(index)),
      providerCount: 32,
      providersOmitted: 7,
    } satisfies EnvironmentProviderSnapshotResult;
    const result = compactAgentProviders(identity, response);
    expect(result).toMatchObject({
      environmentId: "env-a",
      runtime,
      providerCount: 32,
      providersOmitted: 7,
      providersTruncated: true,
    });
    expect(result.providers).toHaveLength(25);
    expect(result.providers[0]).toMatchObject({
      instanceId: "codex_work_0",
      status: "warning",
      availability: "available",
      auth: { status: "authenticated" },
      modelCount: 12,
      skillCount: 4,
      desktopBacked: true,
    });
    expect(result.providers[0]?.message).toBe("x".repeat(2000));
    expect(Buffer.byteLength(encodeAgentOutput(result), "utf8")).toBeLessThan(192 * 1024);
  });
});
