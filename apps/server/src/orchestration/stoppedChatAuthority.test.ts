// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { describe, it, expect } from "vite-plus/test";
import { stoppedChatContext, stoppedChatGuardFailure } from "./stoppedChatAuthority.ts";
import { judgeStoppedChat, stoppedChatCommandKey, type JudgeRequest } from "./stoppedChatJudge.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const AT = "2026-10-06T02:12:00Z";
const turnId = TurnId.make("synthetic-turn");
const threadId = ThreadId.make("synthetic-thread");
type MutableThread = Omit<OrchestrationThread, "messages" | "activities"> & {
  messages: OrchestrationThread["messages"][number][];
  activities: OrchestrationThread["activities"][number][];
};
function fixture(): MutableThread {
  return {
    id: threadId,
    projectId: ProjectId.make("synthetic-project"),
    title: "Synthetic fixture",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    activeOrderKey: null,
    snoozedAt: null,
    snoozedUntil: null,
    pinnedAt: null,
    pinOrderKey: null,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: AT,
      startedAt: AT,
      completedAt: AT,
      assistantMessageId: MessageId.make("synthetic-ask"),
    },
    session: {
      threadId,
      status: "ready",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: AT,
    },
    messages: [
      {
        id: MessageId.make("synthetic-human"),
        role: "user",
        text: "Please update the tracker.",
        turnId,
        streaming: false,
        createdAt: AT,
        updatedAt: AT,
      },
      {
        id: MessageId.make("synthetic-ask"),
        role: "assistant",
        text: "Should I update the tracker?",
        turnId,
        streaming: false,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
  };
}
function command(thread = fixture()) {
  return {
    type: "thread.turn.start" as const,
    commandId: CommandId.make("synthetic-reply"),
    threadId,
    message: {
      messageId: MessageId.make("synthetic-reply"),
      role: "user" as const,
      text: "Yes, update the tracker. I asked for this at 9:12 PM already. (via JEV)",
      attachments: [],
    },
    continuationGuard: stoppedChatContext(thread)!.guard,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: AT,
  };
}
describe("stopped-chat authority", () => {
  it("binds scheduled authority separately and invalidates it on edits or later holds", () => {
    for (const text of [
      "<heartbeat><automation_id>synthetic</automation_id><instructions>Please update the tracker.</instructions></heartbeat>",
      "Automation: Synthetic\nAutomation ID: synthetic\n\nPlease update the tracker.",
      "# Synthetic work - standing assignment from Christine\nPlease update the tracker.\nRun browser-output directory: /Users/synthetic/Codex_Workroom/Automation_Harnesses/synthetic/runs/test",
    ]) {
      const t = fixture();
      t.messages[0] = { ...t.messages[0]!, text };
      const input = stoppedChatContext(t)!;
      expect(input.humans).toHaveLength(0);
      expect(input.saveAuthority).toEqual([
        { id: "synthetic-human", text, at: AT, kind: "routine_prompt" },
      ]);
      expect(stoppedChatGuardFailure(t, input.guard)).toBeNull();
      t.messages[0] = { ...t.messages[0]!, text: text.replace("update", "review") };
      expect(stoppedChatGuardFailure(t, input.guard)).not.toBeNull();
      t.messages.push({ ...t.messages[0]!, id: MessageId.make("new-wait"), text: "Wait." });
      expect(stoppedChatContext(t)).toBeNull();
    }
  });
  it("untagged requested-save replies cannot become human authority", () => {
    const t = fixture();
    t.messages.splice(1, 0, {
      ...t.messages[0]!,
      id: MessageId.make("save-auto"),
      text: "Yes, save it. You asked for this at 9:12 PM CDT.",
    });
    expect(stoppedChatContext(t)!.humans).toHaveLength(1);
    expect(stoppedChatContext(t)!.count).toBe(1);
    expect(stoppedChatGuardFailure(t, stoppedChatContext(t)!.guard)).toMatch(/no tool progress/);
  });
  it("binds exact human revision and ask, and keeps stable idempotency keys", () => {
    const input = stoppedChatContext(fixture())!;
    expect(input.humans).toEqual([
      { id: "synthetic-human", text: "Please update the tracker.", at: AT },
    ]);
    expect(stoppedChatCommandKey(threadId, input)).toBe(stoppedChatCommandKey(threadId, input));
    expect(stoppedChatGuardFailure(fixture(), input.guard)).toBeNull();
  });
  for (const [name, alter] of [
    [
      "newer human message",
      (t: OrchestrationThread) => ({
        ...t,
        messages: [
          ...t.messages,
          { ...t.messages[0]!, id: MessageId.make("new-human"), text: "Wait." },
        ],
      }),
    ],
    [
      "edited human message",
      (t: OrchestrationThread) => ({
        ...t,
        messages: [{ ...t.messages[0]!, text: "Review first." }, t.messages[1]!],
      }),
    ],
    [
      "changed pending ask",
      (t: OrchestrationThread) => ({
        ...t,
        messages: [t.messages[0]!, { ...t.messages[1]!, text: "Should I send the email?" }],
      }),
    ],
    [
      "running turn",
      (t: OrchestrationThread) => ({
        ...t,
        latestTurn: { ...t.latestTurn!, state: "running" as const },
      }),
    ],
    [
      "active session",
      (t: OrchestrationThread) => ({
        ...t,
        session: { ...t.session!, status: "running" as const, activeTurnId: turnId },
      }),
    ],
    [
      "streaming answer",
      (t: OrchestrationThread) => ({
        ...t,
        messages: [t.messages[0]!, { ...t.messages[1]!, streaming: true }],
      }),
    ],
    ["snoozed chat", (t: OrchestrationThread) => ({ ...t, snoozedUntil: "2026-10-07T00:00:00Z" })],
    ["archived chat", (t: OrchestrationThread) => ({ ...t, archivedAt: AT })],
  ] as const) {
    it(`rejects ${name}`, () => {
      const initial = fixture();
      expect(
        stoppedChatGuardFailure(alter(initial), stoppedChatContext(initial)!.guard),
      ).not.toBeNull();
    });
  }
  it("tagged messages cannot reset authority or the continuation cap", () => {
    const t = fixture();
    t.messages.splice(1, 0, {
      ...t.messages[0]!,
      id: MessageId.make("auto"),
      text: "Yes, continue. (via JEV)",
    });
    expect(stoppedChatContext(t)!.humans).toHaveLength(1);
    expect(stoppedChatGuardFailure(t, stoppedChatContext(t)!.guard)).toMatch(/no tool progress/);
    t.activities.push({
      id: EventId.make("tool-proof"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Read tracker",
      payload: { status: "completed" },
      turnId,
      createdAt: AT,
    });
    expect(stoppedChatGuardFailure(t, stoppedChatContext(t)!.guard)).toBeNull();
    t.messages.splice(1, 0, {
      ...t.messages[0]!,
      id: MessageId.make("auto-2"),
      text: "Yes, continue. (via JEV)",
    });
    expect(stoppedChatGuardFailure(t, stoppedChatContext(t)!.guard)).toMatch(/cap/);
  });
  it("native hook feedback cannot produce a second ordinary continuation", () => {
    const t = fixture();
    t.activities.push({
      id: EventId.make("hook"),
      tone: "info",
      kind: "hook.feedback",
      summary: "Hook",
      payload: { feedback: "Yes, update it. (via JEV)" },
      turnId,
      createdAt: AT,
    });
    expect(stoppedChatGuardFailure(t, stoppedChatContext(t)!.guard)).toMatch(/native hook/);
  });
});

effectIt.layer(NodeServices.layer)("serialized delivery guard", (it) => {
  it.effect("persists the untagged reply and rejects missing guards or changed sources", () =>
    Effect.gen(function* () {
      const c = command();
      const message = { ...c.message, text: "Yes, save it. You asked for this at 9:12 PM CDT." };
      const model = { snapshotSequence: 0, projects: [], threads: [fixture()], updatedAt: AT };
      const result = yield* decideOrchestrationCommand({
        command: { ...c, message },
        readModel: model,
      });
      let projected: OrchestrationReadModel = model;
      for (const event of Array.isArray(result) ? result : [result])
        projected = yield* projectEvent(projected, {
          ...event,
          sequence: projected.snapshotSequence + 1,
        });
      expect(projected.threads[0]!.messages.at(-1)!.text).toBe(message.text);
      for (const variant of ["missing-guard", "changed-human", "platform-request"] as const) {
        const t = fixture();
        if (variant === "changed-human") t.messages[0] = { ...t.messages[0]!, text: "Wait." };
        if (variant === "platform-request")
          t.activities.push({
            id: EventId.make("save-approval"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Browser confirmation",
            turnId,
            createdAt: AT,
            payload: { requestId: "synthetic-browser-save-request" },
          });
        const rejected = yield* decideOrchestrationCommand({
          command: {
            ...c,
            message,
            continuationGuard: variant === "missing-guard" ? undefined : c.continuationGuard,
          },
          readModel: { ...model, threads: [t] },
        }).pipe(Effect.flip);
        expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );
  it.effect("persists an ordinary attributed user message through the existing projector", () =>
    Effect.gen(function* () {
      let readModel: OrchestrationReadModel = {
        snapshotSequence: 0,
        projects: [],
        threads: [fixture()],
        updatedAt: AT,
      };
      const result = yield* decideOrchestrationCommand({ command: command(), readModel });
      const events = Array.isArray(result) ? result : [result];
      for (const event of events)
        readModel = yield* projectEvent(readModel, {
          ...event,
          sequence: readModel.snapshotSequence + 1,
        });
      expect(readModel.threads[0]!.messages.at(-1)).toMatchObject({
        role: "user",
        text: command().message.text,
      });
      expect(readModel.threads[0]!.messages.at(-1)!.text).not.toContain("<hook_prompt>");
      const retry = yield* decideOrchestrationCommand({
        command: { ...command(), commandId: CommandId.make("different-id") },
        readModel,
      }).pipe(Effect.flip);
      expect(retry._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
  it.effect("rejects changed humans and outstanding platform requests atomically", () =>
    Effect.gen(function* () {
      for (const variant of ["new-human", "pending-request"] as const) {
        const t = fixture();
        const initial = command(t);
        if (variant === "new-human") t.messages.push({ ...t.messages[0]!, text: "Stop." });
        else
          t.activities.push({
            id: EventId.make("approval"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Browser confirmation",
            turnId,
            createdAt: AT,
            payload: { requestId: "synthetic-browser-request" },
          });
        const result = yield* decideOrchestrationCommand({
          command: initial,
          readModel: { snapshotSequence: 0, projects: [], threads: [t], updatedAt: AT },
        }).pipe(Effect.flip);
        expect(result._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );
  it.effect("rejects unattributed automation and unguarded tags", () =>
    Effect.gen(function* () {
      for (const mode of ["missing-guard", "missing-tag"] as const) {
        const c = command();
        const candidate =
          mode === "missing-guard"
            ? { ...c, continuationGuard: undefined }
            : { ...c, message: { ...c.message, text: "Yes, continue." } };
        const result = yield* decideOrchestrationCommand({
          command: candidate,
          readModel: { snapshotSequence: 0, projects: [], threads: [fixture()], updatedAt: AT },
        }).pipe(Effect.flip);
        expect(result._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );
});

describe("local judge bridge, synthetic account only", () => {
  it("cites a scheduled prompt without passing it off as a typed human message", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "synthetic-routine-save-"));
    try {
      await NodeFSP.mkdir(NodePath.join(home, ".codexdeck"));
      await NodeFSP.writeFile(
        NodePath.join(home, ".codexdeck", "requested_save_t3_enabled"),
        "synthetic",
      );
      const t = fixture();
      t.messages[0] = {
        ...t.messages[0]!,
        text: "Automation: Synthetic\nAutomation ID: synthetic\n\nPlease update the tracker.",
      };
      const input = stoppedChatContext(t)!;
      const result = await judgeStoppedChat(input, threadId, NodePath.join(home, ".t3"), {
        home,
        request: async () => {
          throw new Error("No JEV calls");
        },
        requestedSave: async (received) => {
          expect(received.humans).toEqual([]);
          expect(received.saveAuthority[0]!.kind).toBe("routine_prompt");
          return {
            status: "yes",
            message: "Yes, save it. You asked for this at 9:12 PM CDT.",
            source_id: "synthetic-human",
            citation: t.messages[0]!.text,
            citation_at: AT,
          };
        },
      });
      expect(result!.decision.reason).toBe("standing_routine_request");
      expect(result!.text).not.toContain("JEV");
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });
  it("answers requested saves before JEV without credentials or a model verdict", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "synthetic-requested-save-"));
    try {
      await NodeFSP.mkdir(NodePath.join(home, ".codexdeck"));
      await NodeFSP.writeFile(
        NodePath.join(home, ".codexdeck", "requested_save_t3_enabled"),
        "synthetic",
      );
      const input = stoppedChatContext(fixture())!;
      const result = await judgeStoppedChat(input, threadId, NodePath.join(home, ".t3"), {
        home,
        request: async () => {
          throw new Error("JEV must not be called");
        },
        requestedSave: async (received) => {
          expect(received.humans).toEqual(input.humans);
          expect(received.question).toBe(input.question);
          return {
            status: "yes",
            message: "Yes, save it. You asked for this at 9:12 PM CDT.",
            source_id: "synthetic-human",
            citation: "Please update the tracker.",
            citation_at: AT,
          };
        },
      });
      expect(result!.text).toBe("Yes, save it. You asked for this at 9:12 PM CDT.");
      expect(result!.decision.source).toBe("requested_save");
      for (const answer of [
        { status: "hold" },
        {
          status: "yes",
          message: "Yes, save it. You asked for this at 9:12 PM CDT.",
          source_id: "synthetic-human",
          citation: "Send money.",
          citation_at: AT,
        },
        {
          status: "yes",
          message: "Yes, save it. (via JEV)",
          source_id: "synthetic-human",
          citation: "Please update the tracker.",
          citation_at: AT,
        },
      ]) {
        const held = await judgeStoppedChat(input, threadId, NodePath.join(home, ".t3"), {
          home,
          requestedSave: async () => answer,
          request: async () => {
            throw new Error("No JEV marker or credentials exist");
          },
        });
        expect(held).toBeNull();
      }
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });
  it("sends only the two authority inputs and renders a cited ordinary sentence", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "synthetic-stopped-chat-"));
    try {
      await NodeFSP.mkdir(NodePath.join(home, ".codexdeck"));
      await NodeFSP.writeFile(NodePath.join(home, ".codexdeck", "jev_t3_enabled"), "synthetic");
      await NodeFSP.writeFile(
        NodePath.join(home, ".codexdeck", "agent_token"),
        "synthetic-not-a-secret",
      );
      let calls = 0;
      const request: JudgeRequest = async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        expect(Object.keys(body).sort()).toEqual([
          "action_route",
          "christine_messages",
          "machine",
          "question",
          "thread_id",
          "turn_id",
        ]);
        expect(body.christine_messages).toEqual(stoppedChatContext(fixture())!.humans);
        return new Response(
          JSON.stringify({
            act: true,
            verdict: "already_approved",
            intent: "yes",
            citation_message_id: "synthetic-human",
            citation: "Please update the tracker.",
            citation_at: AT,
          }),
        );
      };
      expect(
        await judgeStoppedChat(
          stoppedChatContext(fixture())!,
          threadId,
          NodePath.join(home, "other-test-home"),
          { home, request },
        ),
      ).toBeNull();
      expect(calls).toBe(0);
      const result = await judgeStoppedChat(
        stoppedChatContext(fixture())!,
        threadId,
        NodePath.join(home, ".t3"),
        { home, request },
      );
      expect(result!.text).toBe(command().message.text);
      const held: JudgeRequest = async () =>
        new Response(
          JSON.stringify({ act: false, verdict: "ask_christine", reason: "API route needed" }),
        );
      expect(
        (await judgeStoppedChat(
          stoppedChatContext(fixture())!,
          threadId,
          NodePath.join(home, ".t3"),
          { home, request: held },
        ))!.text,
      ).toBeNull();
      const wrongCitation: JudgeRequest = async () =>
        new Response(
          JSON.stringify({
            act: true,
            verdict: "already_approved",
            intent: "yes",
            citation_message_id: "synthetic-human",
            citation: "Send money.",
            citation_at: AT,
          }),
        );
      expect(
        (await judgeStoppedChat(
          stoppedChatContext(fixture())!,
          threadId,
          NodePath.join(home, ".t3"),
          { home, request: wrongCitation },
        ))!.text,
      ).toBeNull();
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });
});
