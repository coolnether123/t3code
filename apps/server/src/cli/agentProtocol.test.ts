import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  EnvironmentProviderStatus,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  ProviderInstanceId,
  type EnvironmentProviderSnapshotResult,
} from "@t3tools/contracts";
import {
  AGENT_REQUEST_MAX_BYTES,
  compactAgentProviders,
  decodeAgentAction,
  decodeAgentRequest,
  validateAgentAction,
  compactAgentSnapshot,
  validateAgentOrigin,
  encodeAgentOutput,
  validateAgentReceiptMetadata,
  AGENT_RECEIPT_METADATA_MAX_BYTES,
  AGENT_OUTPUT_MAX_BYTES,
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
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: {
    turnId: "turn-a",
    state: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    assistantMessageId: null,
  },
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  messages: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: "thread-a",
    status: "running",
    providerName: "codex",
    runtimeMode: "approval-required",
    activeTurnId: "turn-a",
    lastError: null,
    updatedAt: now,
  },
};
const decodeDetail = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot);
const decodeShell = Schema.decodeUnknownSync(OrchestrationShellSnapshot);
const detail = decodeDetail({
  snapshotSequence: 12,
  thread,
  page: { beforeCursor: "older", hasMore: true, snapshotSequence: 12 },
});
const shell = decodeShell({
  snapshotSequence: 12,
  projects: [],
  threads: [
    {
      ...thread,
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ],
  updatedAt: now,
});
const envelope = (command: unknown) => encodeJson({ ...identity, command });
const interrupt = {
  type: "thread.turn.interrupt",
  commandId: "command-a",
  threadId: "thread-a",
  turnId: "turn-a",
  createdAt: now,
};

describe("agent action boundary", () => {
  it("decodes an existing command with explicit environment and runtime identity", () => {
    expect(decodeAgentAction(envelope(interrupt)).command).toEqual(interrupt);
  });
  it("rejects unknown fields, oversized input and destructive commands", () => {
    expect(() => decodeAgentAction(envelope({ ...interrupt, typo: true }))).toThrow();
    expect(() => decodeAgentAction(" ".repeat(262145))).toThrow();
    expect(() =>
      decodeAgentAction(envelope({ type: "thread.delete", commandId: "x", threadId: "thread-a" })),
    ).toThrow();
  });
  it("strictly decodes one bounded request object and preserves action confirmation", () => {
    expect(decodeAgentRequest('{"kind":"capabilities"}')).toEqual({ kind: "capabilities" });
    expect(() => decodeAgentRequest("{invalid")).toThrow();
    expect(() => decodeAgentRequest('{"kind":"snapshot"} {}')).toThrow();
    expect(() => decodeAgentRequest('{"kind":"unknown"}')).toThrow();
    expect(() => decodeAgentRequest(encodeJson({ kind: "capabilities", extra: true }))).toThrow();
    expect(() =>
      decodeAgentRequest(
        encodeJson({ kind: "capabilities", padding: "x".repeat(AGENT_REQUEST_MAX_BYTES) }),
      ),
    ).toThrow();
    expect(() =>
      decodeAgentRequest(encodeJson({ kind: "act", ...identity, command: interrupt })),
    ).toThrow();
    expect(() =>
      decodeAgentRequest(
        encodeJson({
          kind: "act",
          confirm: true,
          ...identity,
          command: { ...interrupt, extra: true },
        }),
      ),
    ).toThrow();

    expect(
      decodeAgentRequest(
        encodeJson({ kind: "act", confirm: true, ...identity, command: interrupt }),
      ),
    ).toMatchObject({ kind: "act", action: { command: interrupt } });
  });
  it("validates request options against the CLI flag bounds", () => {
    expect(
      decodeAgentRequest(
        encodeJson({
          kind: "snapshot",
          thread: "thread-a",
          turnLimit: 5,
          offset: 1_000_000,
          beforeCursor: "cursor-a",
        }),
      ),
    ).toMatchObject({ kind: "snapshot", threadId: "thread-a", turnLimit: 5, offset: 1_000_000 });
    expect(() => decodeAgentRequest('{"kind":"snapshot","turnLimit":6}')).toThrow();
    expect(() => decodeAgentRequest('{"kind":"snapshot","beforeCursor":"older"}')).toThrow();
    expect(() => decodeAgentRequest('{"kind":"providers","instance":"bad id"}')).toThrow();
    expect(decodeAgentRequest('{"kind":"providers","instance":"codex_work"}')).toEqual({
      kind: "providers",
      instanceId: ProviderInstanceId.make("codex_work"),
    });
  });
  it("refuses missing or stale turn IDs and wrong environments before dispatch", () => {
    expect(() => decodeAgentAction(envelope({ ...interrupt, turnId: undefined }))).toThrow();
    const action = decodeAgentAction(envelope(interrupt));
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
        decodeAgentAction(envelope({ ...interrupt, turnId: "old" })),
        identity,
        shell,
        detail,
      ),
    ).toThrow();
    expect(() => validateAgentAction(action, identity, shell, detail)).not.toThrow();
  });
  it("rejects bootstrap and permission weakening", () => {
    const start = {
      type: "thread.turn.start",
      commandId: "send-a",
      threadId: "thread-a",
      message: { messageId: "message-a", role: "user", text: "hello", attachments: [] },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: now,
    };
    expect(() => decodeAgentAction(envelope({ ...start, bootstrap: {} }))).toThrow();
    expect(() =>
      validateAgentAction(
        decodeAgentAction(envelope({ ...start, runtimeMode: "full-access" })),
        identity,
        shell,
        detail,
      ),
    ).toThrow();
  });
  it("allows only bare loopback origins, never credential-bearing or redirected URLs", () => {
    expect(validateAgentOrigin("http://127.0.0.1:8282")).toBe("http://127.0.0.1:8282");
    for (const url of [
      "http://example.com",
      "http://user:secret@localhost:8282",
      "http://localhost:8282/path",
      "http://localhost:8282?token=x",
    ]) {
      expect(() => validateAgentOrigin(url)).toThrow();
    }
  });
});

describe("agent snapshot", () => {
  it("budgets complete encoded receipt metadata and leaves room for fallback output", () => {
    const metadata = {
      ...identity,
      origin: "http://127.0.0.1:8282",
      commandId: "i".repeat(AGENT_RECEIPT_METADATA_MAX_BYTES - 1000),
      commandType: "thread.turn.steer",
      target: { threadId: "thread-a", turnId: "turn-a", messageId: "message-a" },
    };
    expect(() => validateAgentReceiptMetadata(metadata)).not.toThrow();
    expect(() =>
      validateAgentReceiptMetadata({ ...metadata, environmentId: "界".repeat(40000) }),
    ).toThrow();
    expect(() =>
      validateAgentReceiptMetadata({
        ...metadata,
        commandId: "normal",
        target: { projectId: "\u0000".repeat(20000) },
      }),
    ).toThrow();
    for (const status of ["accepted", "unknown"]) {
      const output = encodeAgentOutput({
        ...metadata,
        status,
        sequence: 13,
        providerCompletion: "not-confirmed",
        projectionObserved: false,
        readback: "x".repeat(AGENT_OUTPUT_MAX_BYTES),
      });
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(AGENT_OUTPUT_MAX_BYTES);
      expect(output).toContain(metadata.commandId);
      expect(output).toContain(`"status":"${status}"`);
    }
  });
  it("keeps IDs, pagination and old approval evidence outside the activity tail", () => {
    const approval = {
      id: "approval-event",
      tone: "approval",
      kind: "approval.requested",
      summary: "Approve command",
      payload: { requestId: "approval-a", requestKind: "command", detail: "echo ok" },
      turnId: "turn-a",
      createdAt: now,
    };
    const large = decodeDetail({
      ...detail,
      thread: {
        ...thread,
        activities: [
          approval,
          ...Array.from({ length: 50 }, (_, i) => ({
            ...approval,
            id: `event-${i}`,
            kind: "tool.updated",
            payload: { image: "x".repeat(10000) },
          })),
        ],
      },
    });
    const result = compactAgentSnapshot(identity, shell, large);
    expect(result.thread?.id).toBe("thread-a");
    expect(result.thread?.requests[0]?.requestId).toBe("approval-a");
    expect(result.thread?.page?.hasMore).toBe(true);
    expect(result.thread?.activities.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(encodeAgentOutput(result), "utf8")).toBeLessThan(40_000);
  });
  it("pages both lists without skipping entries and bounds error/output text", () => {
    const many = decodeShell({
      ...shell,
      threads: Array.from({ length: 52 }, (_, i) => ({ ...shell.threads[0], id: `thread-${i}` })),
    });
    expect(compactAgentSnapshot(identity, many).listPage.nextOffset).toBe(25);
    const second = compactAgentSnapshot(identity, many, undefined, 25);
    expect(second.threads[0]?.id).toBe("thread-25");
    expect(second.listPage.nextOffset).toBe(50);
    expect(compactAgentSnapshot(identity, many, undefined, 50).listPage.nextOffset).toBeNull();
    const failed = decodeDetail({
      ...detail,
      thread: { ...thread, session: { ...thread.session, lastError: "error".repeat(10000) } },
    });
    expect(
      compactAgentSnapshot(identity, shell, failed).thread?.session?.lastError?.length,
    ).toBeLessThan(2100);
    const receipt = encodeAgentOutput({
      status: "accepted",
      commandId: "command-a",
      sequence: 13,
      readback: "x".repeat(200000),
    });
    expect(receipt).toContain('"sequence":13');
    expect(receipt).toContain("Readback omitted");
    expect(Buffer.byteLength(receipt)).toBeLessThan(192 * 1024);
  });
  it("retains user-input choices and removes resolved request evidence", () => {
    const requested = {
      id: "event-a",
      tone: "approval",
      kind: "user-input.requested",
      summary: "Pick",
      payload: {
        requestId: "request-a",
        questions: [
          { id: "q-a", question: "Pick one", options: [{ label: "One", description: "First" }] },
        ],
      },
      turnId: "turn-a",
      createdAt: now,
      sequence: 1,
    };
    const open = decodeDetail({ ...detail, thread: { ...thread, activities: [requested] } });
    expect(
      compactAgentSnapshot(identity, shell, open).thread?.requests[0]?.questions,
    ).toMatchObject([{ id: "q-a", options: [{ label: "One" }] }]);
    const closed = decodeDetail({
      ...detail,
      thread: {
        ...thread,
        activities: [
          requested,
          { ...requested, id: "event-b", kind: "user-input.resolved", sequence: 2 },
        ],
      },
    });
    expect(compactAgentSnapshot(identity, shell, closed).thread?.requests).toEqual([]);
    const manyChoices = decodeDetail({
      ...detail,
      thread: {
        ...thread,
        activities: [
          {
            ...requested,
            payload: {
              ...requested.payload,
              questions: [
                {
                  id: "q-a",
                  question: "Pick one",
                  options: Array.from({ length: 12 }, (_, i) => ({
                    label: `Choice ${i}`,
                    description: "Details",
                  })),
                },
              ],
            },
          },
        ],
      },
    });
    expect(
      compactAgentSnapshot(identity, shell, manyChoices).thread?.requests[0]?.questionsTruncated,
    ).toBe(true);
  });
  it("retains session identity and the newest generic session-info activities", () => {
    const activities = [
      {
        id: "inventory-event",
        tone: "info",
        kind: "session.tool-inventory",
        summary: "Tool inventory observed",
        payload: {
          inventory: ["node_repl", "cua_repl"],
          accessToken: "fake-provider-session-token",
        },
        turnId: null,
        sequence: 1,
        createdAt: now,
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `tool-${index}`,
        tone: "tool",
        kind: "tool.updated",
        summary: `Tool ${index}`,
        payload: { name: `tool-${index}` },
        turnId: "turn-a",
        sequence: index + 2,
        createdAt: now,
      })),
    ];
    const selected = decodeDetail({
      ...detail,
      thread: {
        ...thread,
        session: {
          ...thread.session,
          providerInstanceId: "codex_work",
          lastError: "transport stopped",
        },
        activities,
      },
    });
    const snapshot = compactAgentSnapshot(identity, shell, selected);
    expect(snapshot.thread?.session).toMatchObject({
      providerInstanceId: "codex_work",
      status: "running",
      lastError: "transport stopped",
    });
    expect(snapshot.thread?.latestTurn).toMatchObject({ state: "running", turnId: "turn-a" });
    expect(snapshot.thread?.activities).toHaveLength(20);
    expect(snapshot.thread?.recentSessionInfoActivities).toMatchObject([
      {
        kind: "session.tool-inventory",
        payload: {
          inventory: ["node_repl", "cua_repl"],
          accessToken: "[redacted]",
        },
      },
    ]);
    expect(snapshot.thread?.sessionInfoActivitiesOmitted).toBe(0);
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
