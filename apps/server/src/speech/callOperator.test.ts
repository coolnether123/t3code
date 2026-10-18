// @effect-diagnostics nodeBuiltinImport:off - Synthetic call archives exercise durable boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderRuntimeEvent, ProviderInstanceId, type CallModels } from "@t3tools/contracts";
import { CallStore } from "./callStore.ts";
import { CallService } from "./callService.ts";
import { CallOperator, type OperatorPorts } from "./callOperator.ts";
import {
  CallReplyBuffer,
  operatorPrompt,
  operatorUpdates,
  voiceDelegation,
  withoutCallControl,
} from "./operatorProtocol.ts";

const models: CallModels = {
  voice: {
    instanceId: ProviderInstanceId.make("voice-instance"),
    model: "synthetic-voice",
    options: [{ id: "effort", value: "medium" }],
  },
  operator: {
    instanceId: ProviderInstanceId.make("operator-instance"),
    model: "synthetic-operator",
    options: [{ id: "reasoningEffort", value: "medium" }],
  },
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await NodeFSP.rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-operator-synthetic-"));
  directories.push(directory);
  const store = new CallStore(directory);
  const sessions: { threadId: string }[] = [];
  const ports: OperatorPorts = {
    context: vi.fn(async () => ({
      cwd: directory,
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      conversation: '[{"role":"user","text":"The build in this workspace."}]',
    })),
    start: vi.fn(async (input) => {
      sessions.push({ threadId: input.threadId });
    }),
    send: vi.fn(async () => ({})),
    sessions: async () => sessions,
    dispatch: vi.fn(async () => ({})),
  };
  const operator = new CallOperator(store);
  operator.bind(ports);
  await operator.configure("chat", models);
  const event = (sessionId: string, type: string, turnId: string, payload: unknown = {}) =>
    Schema.decodeUnknownSync(ProviderRuntimeEvent)({
      type,
      eventId: `${type}-${turnId}-${JSON.stringify(payload)}`,
      provider: "codex",
      threadId: sessionId,
      createdAt: "2026-10-18T15:00:00.000Z",
      turnId,
      payload,
    });
  const startVoice = async (
    id = "voice:call:utterance",
    text = "Check that build, using my exact words.",
  ) => {
    await operator.voice({ threadId: "chat", messageId: id, text, selection: models.voice });
    const link = (await operator.read("chat"))!.links.find((link) => link.role === "voice")!;
    await operator.event(event(link.sessionId, "turn.started", id));
    return link;
  };
  return { store, ports, operator, event, startVoice };
}

describe("call delegation", () => {
  it("parses bounded typed control and keeps partial control out of speech", () => {
    expect(
      voiceDelegation('On it. <otis-delegate>{"intent":"Read the build status"}</otis-delegate>'),
    ).toEqual({ intent: "Read the build status" });
    expect(() => voiceDelegation('<otis-delegate>{"intent":""}</otis-delegate>')).toThrow();
    expect(() => voiceDelegation('<otis-delegate>{"intent":"Read"}')).toThrow();
    expect(() =>
      operatorUpdates('<otis-status>{"status":"complete","text":"done"}</otis-status>'),
    ).toThrow();
    expect(withoutCallControl("On it. <otis-del")).toBe("On it. ");
    expect(withoutCallControl('On it. <otis-delegate>{"intent":"read"}</otis-delegate>')).toBe(
      "On it. ",
    );
  });
  it("retains a completion-only handoff following a streamed acknowledgment without duplicating text", async () => {
    const f = await fixture();
    const buffer = new CallReplyBuffer();
    const delta = f.event("t3-call-voice", "content.delta", "turn", {
      streamKind: "assistant_text",
      delta: "On it. ",
    });
    expect(buffer.accept(delta).delta).toBe("On it. ");
    buffer.accept(
      f.event("t3-call-voice", "item.completed", "turn", {
        itemType: "assistant_message",
        status: "completed",
        detail: 'On it. <otis-delegate>{"intent":"Read"}</otis-delegate>',
      }),
    );
    const result = buffer.accept(
      f.event("t3-call-voice", "turn.completed", "turn", { state: "completed" }),
    );
    expect(voiceDelegation(result.raw)?.intent).toBe("Read");
    expect(result.raw.match(/On it/g)).toHaveLength(1);
  });
  it("never delegates an interrupted or failed voice turn", async () => {
    const f = await fixture();
    const link = await f.startVoice();
    await f.operator.event(
      f.event(link.sessionId, "turn.completed", "voice:call:utterance", { state: "failed" }),
      '<otis-delegate>{"intent":"Run"}</otis-delegate>',
    );
    await f.operator.drain();
    expect((await f.operator.read("chat"))!.jobs).toHaveLength(0);
  });
  it("starts tool-free voice first and delegates exact words, intent, context and options once", async () => {
    const f = await fixture();
    const link = await f.startVoice();
    expect(f.ports.start).toHaveBeenCalledWith(
      expect.objectContaining({
        toolMode: "none",
        modelSelection: models.voice,
        runtimeMode: "approval-required",
      }),
    );
    expect(f.ports.send).toHaveBeenCalledTimes(1);
    const complete = f.event(link.sessionId, "turn.completed", "voice:call:utterance", {
      state: "completed",
    });
    await f.operator.event(
      complete,
      'On it. <otis-delegate>{"intent":"Read the build status"}</otis-delegate>',
    );
    await f.operator.drain();
    await f.operator.event(
      complete,
      'On it. <otis-delegate>{"intent":"Read the build status"}</otis-delegate>',
    );
    await f.operator.drain();
    expect(f.ports.send).toHaveBeenCalledTimes(2);
    const job = (await f.operator.read("chat"))!.jobs[0]!;
    expect(job.selection).toEqual(models.operator);
    expect(job.exactWords).toBe("Check that build, using my exact words.");
    expect(operatorPrompt(job)).toContain("The build in this workspace.");
    expect(operatorPrompt(job)).toContain("Read the build status");
    expect(f.ports.start).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ toolMode: "none" }),
    );
    expect((await f.operator.read("chat"))!.updates[0]?.status).toBe("started");
  });
  it("answers without delegation and never starts an operator for ordinary conversation", async () => {
    const f = await fixture();
    const link = await f.startVoice();
    await f.operator.event(
      f.event(link.sessionId, "turn.completed", "voice:call:utterance", { state: "completed" }),
      "The earlier build passed.",
    );
    await f.operator.drain();
    expect((await f.operator.read("chat"))!.jobs).toEqual([]);
    expect(f.ports.send).toHaveBeenCalledTimes(1);
  });
  it("pins each delegated selection and applies a model change on the next voice turn", async () => {
    const f = await fixture();
    const link = await f.startVoice();
    const next = { ...models, operator: { ...models.operator, model: "synthetic-next" } };
    await f.operator.configure("chat", next, true);
    await f.operator.event(
      f.event(link.sessionId, "turn.completed", "voice:call:utterance", { state: "completed" }),
      '<otis-delegate>{"intent":"Read"}</otis-delegate>',
    );
    await f.operator.drain();
    expect((await f.operator.read("chat"))!.jobs[0]?.selection).toEqual(models.operator);
    await f.startVoice("voice:call:next");
    await f.operator.event(
      f.event(link.sessionId, "turn.completed", "voice:call:next", { state: "completed" }),
      '<otis-delegate>{"intent":"Read next"}</otis-delegate>',
    );
    await f.operator.drain();
    expect((await f.operator.read("chat"))!.jobs[1]?.selection).toEqual(next.operator);
    expect(await new CallOperator(f.store).defaults()).toEqual(next);
  });
  it("does not report an untyped or failed operator completion as done", async () => {
    const f = await fixture();
    const link = await f.startVoice();
    await f.operator.event(
      f.event(link.sessionId, "turn.completed", "voice:call:utterance", { state: "completed" }),
      '<otis-delegate>{"intent":"Check"}</otis-delegate>',
    );
    await f.operator.drain();
    const job = (await f.operator.read("chat"))!.jobs[0]!;
    await f.operator.event(f.event(job.sessionId!, "turn.started", "operator-turn"));
    await f.operator.event(
      f.event(job.sessionId!, "item.completed", "operator-turn", {
        itemType: "assistant_message",
        status: "completed",
        detail: '<otis-status>{"status":"done","text":"Claimed too early."}</otis-status>',
      }),
    );
    expect(
      (await f.operator.read("chat"))!.updates.some((update) => update.status === "done"),
    ).toBe(false);
    await f.operator.event(
      f.event(job.sessionId!, "turn.completed", "operator-turn", { state: "failed" }),
    );
    await f.operator.drain();
    const updates = (await f.operator.read("chat"))!.updates;
    expect(updates.some((update) => update.status === "done")).toBe(false);
    expect(updates.at(-1)?.status).toBe("needs-Jared");
  });
  it("retains later results after hang-up and announces unheard results on the next call", async () => {
    const f = await fixture();
    const link = await f.startVoice();
    await f.operator.event(
      f.event(link.sessionId, "turn.completed", "voice:call:utterance", { state: "completed" }),
      '<otis-delegate>{"intent":"Check"}</otis-delegate>',
    );
    await f.operator.drain();
    const job = (await f.operator.read("chat"))!.jobs[0]!;
    const speech = vi.fn(async () => ({}));
    const call = new CallService(
      f.store,
      {
        verify: async () => ({ runtimeMode: "approval-required", interactionMode: "default" }),
        dispatch: f.ports.dispatch,
        speech,
        tenants: ["stt", "tts"],
        ttsModel: "synthetic-tts",
      },
      f.operator,
    );
    await call.handle(
      {
        action: "call.open",
        callId: "old-call",
        options: {
          threadId: "chat",
          modelSelection: models.voice,
          operatorSelection: models.operator,
        },
      },
      new AbortController().signal,
    );
    await call.handle({ action: "call.close", callId: "old-call" }, new AbortController().signal);
    expect((await f.operator.read("chat"))!.jobs[0]?.phase).toBe("running");
    await f.operator.event(f.event(job.sessionId!, "turn.started", "operator-turn"));
    await f.operator.event(
      f.event(job.sessionId!, "item.completed", "operator-turn", {
        itemType: "assistant_message",
        status: "completed",
        detail: '<otis-status>{"status":"done","text":"Build passed."}</otis-status>',
      }),
    );
    await f.operator.event(
      f.event(job.sessionId!, "turn.completed", "operator-turn", { state: "completed" }),
    );
    await f.operator.drain();
    const reopened = new CallOperator(f.store);
    reopened.bind(f.ports);
    expect(
      (await call.status("old-call")).operatorUpdates?.some((update) => update.status === "done"),
    ).toBe(true);
    await reopened.announce("chat", "next-call");
    const updates = (await reopened.read("chat"))!.updates;
    expect(updates.find((update) => update.status === "done")?.heardAt).toBeUndefined();
    expect(f.ports.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        threadId: "chat",
        modelSelection: models.voice,
      }),
    );
    await reopened.heard(
      "chat",
      updates.filter((update) => update.status === "done").map((update) => update.id),
    );
    expect(
      (await reopened.read("chat"))!.updates.find((update) => update.status === "done")?.heardAt,
    ).toBeDefined();
  });
});
