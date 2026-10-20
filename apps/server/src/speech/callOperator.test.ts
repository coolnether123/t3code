import type { CallCommand as OrchestrationCommand } from "./commands.ts";
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
  const waits: { milliseconds: number; resolve(): void }[] = [];
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
  const operator = new CallOperator(
    store,
    (milliseconds) =>
      new Promise<void>((resolve) => {
        waits.push({ milliseconds, resolve });
      }),
  );
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
  const startOperator = async () => {
    const link = await startVoice();
    await operator.event(
      event(link.sessionId, "turn.completed", "voice:call:utterance", { state: "completed" }),
      '<otis-delegate>{"intent":"Check the build"}</otis-delegate>',
    );
    await operator.drain();
    const job = (await operator.read("chat"))!.jobs[0]!;
    await operator.event(event(job.sessionId!, "turn.started", "operator-0"));
    return job;
  };
  return { store, ports, operator, event, startVoice, startOperator, waits };
}

describe("call delegation", () => {
  it.each(["error", "closed"] as const)(
    "settles a failed voice turn and recreates a %s session for the next utterance",
    async (status) => {
      const f = await fixture();
      const link = await f.startVoice();
      f.ports.sessions = async () => [{ threadId: link.sessionId, status }];
      await f.operator.event(
        f.event(link.sessionId, "runtime.error", "voice:call:utterance", {
          message: "Synthetic stream failure",
        }),
      );
      expect((await f.operator.read("chat"))!.voices[0]?.finished).toBe(true);
      expect(await f.startVoice("next-utterance", "Hello again")).toEqual(link);
      expect(f.ports.start).toHaveBeenCalledTimes(2);
      await f.operator.event(
        f.event(link.sessionId, "turn.completed", "next-utterance", { state: "completed" }),
        "Hello",
      );
      expect((await f.operator.read("chat"))!.voices.every((voice) => voice.finished)).toBe(true);
    },
  );
  it("retries a saved voice request after a rejected send and acknowledges only acceptance", async () => {
    const f = await fixture();
    vi.mocked(f.ports.send).mockRejectedValueOnce(new Error("Provider send failed"));
    const input = {
      threadId: "chat",
      messageId: "failed-voice",
      text: "Hello",
      selection: models.voice,
    };
    await expect(f.operator.voice(input)).rejects.toThrow("Provider send failed");
    expect((await f.operator.read("chat"))!.voices).toMatchObject([
      { accepted: false, finished: true },
    ]);
    await expect(f.operator.voice(input)).resolves.toBe(true);
    await expect(f.operator.voice(input)).resolves.toBe(true);
    expect(f.ports.send).toHaveBeenCalledTimes(2);
    expect((await f.operator.read("chat"))!.voices).toMatchObject([
      { accepted: true, finished: false },
    ]);
  });
  it("keeps failed announcements retryable and waits for the active voice turn", async () => {
    const f = await fixture();
    await f.operator.update("chat", "job", "done", "done", "Build passed");
    vi.mocked(f.ports.dispatch).mockImplementationOnce(async () => {
      throw new Error("Dispatch failed");
    });
    await expect(f.operator.announce("chat", "call")).rejects.toThrow("Dispatch failed");
    expect((await f.operator.read("chat"))!.updates[0]?.announcementId).toBeUndefined();
    await expect(f.operator.announce("chat", "call")).resolves.toBe(true);
    const voice = await f.startVoice();
    await f.operator.update("chat", "next-job", "next-result", "done", "Another result");
    await expect(f.operator.announce("chat", "call")).resolves.toBe(false);
    await expect(
      f.operator.voice({
        threadId: "chat",
        messageId: "another",
        text: "Next",
        selection: models.voice,
      }),
    ).rejects.toThrow("still active");
    await f.operator.event(
      f.event(voice.sessionId, "turn.completed", "voice:call:utterance", { state: "completed" }),
    );
    await expect(
      f.operator.voice({
        threadId: "chat",
        messageId: "another",
        text: "Next",
        selection: models.voice,
      }),
    ).resolves.toBe(true);
  });
  it.each([
    "Selected model is at capacity. Please try a different model.",
    "Provider rejected the request.",
  ])(
    "retries serverOverloaded on the pinned model and ignores late receipts: %s",
    async (message) => {
      const f = await fixture();
      const job = await f.startOperator();
      const failure = f.event(job.sessionId!, "runtime.error", "operator-0", {
        class: "provider_error",
        message,
        detail: { error: { codexErrorInfo: "serverOverloaded" }, willRetry: false },
      });
      await f.operator.event(failure);
      await f.operator.event(failure);
      expect(f.waits.map((wait) => wait.milliseconds)).toEqual([1000]);
      expect((await f.operator.read("chat"))!.updates.at(-1)).toMatchObject({
        status: "progress",
        text: expect.stringContaining("Retrying"),
      });
      expect(
        (await f.operator.read("chat"))!.updates.some((update) => update.status === "needs-Jared"),
      ).toBe(false);
      const call = new CallService(
        f.store,
        {
          verify: async () => ({ runtimeMode: "approval-required", interactionMode: "default" }),
          dispatch: f.ports.dispatch,
          speech: async () => ({}),
          tenants: ["stt", "tts"],
          ttsModel: "synthetic-tts",
        },
        f.operator,
      );
      await call.handle(
        {
          action: "call.open",
          callId: "retry-call",
          options: {
            threadId: "chat",
            modelSelection: models.voice,
            operatorSelection: models.operator,
          },
        },
        new AbortController().signal,
      );
      await call.handle(
        { action: "call.close", callId: "retry-call" },
        new AbortController().signal,
      );
      await f.operator.event(
        f.event(job.sessionId!, "turn.completed", "operator-0", { state: "failed" }),
      );
      await f.operator.configure("chat", {
        ...models,
        operator: { ...models.operator, model: "next-selection" },
      });
      f.waits[0]!.resolve();
      await f.operator.drain();
      expect(f.ports.send).toHaveBeenCalledTimes(3);
      expect(f.ports.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          modelSelection: models.operator,
          messageId: `${job.id}:retry:1`,
          input: expect.stringContaining(job.exactWords),
        }),
      );
      expect(f.ports.start).toHaveBeenCalledTimes(2);
      await f.operator.event(failure);
      await f.operator.event(
        f.event(job.sessionId!, "turn.completed", "operator-0", { state: "failed" }),
      );
      expect((await f.operator.read("chat"))!.jobs[0]?.phase).toBe("running");
      await f.operator.event(f.event(job.sessionId!, "turn.started", "operator-1"));
      await f.operator.event(
        f.event(job.sessionId!, "item.completed", "operator-1", {
          itemType: "assistant_message",
          status: "completed",
          detail: '<otis-status>{"status":"done","text":"Build passed."}</otis-status>',
        }),
      );
      await f.operator.event(
        f.event(job.sessionId!, "turn.completed", "operator-1", { state: "completed" }),
      );
      await f.operator.drain();
      expect(
        (await f.operator.read("chat"))!.updates.filter((update) => update.status === "done"),
      ).toHaveLength(1);
      expect((await f.operator.read("chat"))!.updates.at(-1)?.text).toBe("Build passed.");
    },
  );
  it("does not reuse a done claim from a rejected attempt", async () => {
    const f = await fixture();
    const job = await f.startOperator();
    await f.operator.event(
      f.event(job.sessionId!, "item.completed", "operator-0", {
        itemType: "assistant_message",
        status: "completed",
        detail: '<otis-status>{"status":"done","text":"Not verified."}</otis-status>',
      }),
    );
    await f.operator.event(
      f.event(job.sessionId!, "runtime.error", "operator-0", {
        class: "provider_error",
        message: "Server overloaded.",
      }),
    );
    f.waits[0]!.resolve();
    await f.operator.drain();
    await f.operator.event(f.event(job.sessionId!, "turn.started", "operator-1"));
    await f.operator.event(
      f.event(job.sessionId!, "turn.completed", "operator-1", { state: "completed" }),
    );
    await f.operator.drain();
    const updates = (await f.operator.read("chat"))!.updates;
    expect(updates.some((update) => update.status === "done")).toBe(false);
    expect(updates.at(-1)?.status).toBe("needs-Jared");
  });
  it("backs off three times for failed capacity turns, then asks Jared without changing models", async () => {
    const f = await fixture();
    const job = await f.startOperator();
    for (let attempt = 0; attempt < 4; attempt++) {
      await f.operator.event(
        f.event(job.sessionId!, "turn.completed", `operator-${attempt}`, {
          state: "failed",
          errorMessage: "Selected model is at capacity.",
        }),
      );
      if (attempt < 3) {
        expect(
          (await f.operator.read("chat"))!.updates.some(
            (update) => update.status === "needs-Jared",
          ),
        ).toBe(false);
        f.waits[attempt]!.resolve();
        await f.operator.drain();
        await f.operator.event(f.event(job.sessionId!, "turn.started", `operator-${attempt + 1}`));
      }
    }
    await f.operator.drain();
    expect(f.waits.map((wait) => wait.milliseconds)).toEqual([1000, 2000, 4000]);
    const requests = vi
      .mocked(f.ports.send)
      .mock.calls.slice(1)
      .map(([input]) => input);
    expect(requests).toHaveLength(4);
    for (const input of requests) expect(input.modelSelection).toEqual(models.operator);
    expect(new Set(requests.map((input) => input.messageId)).size).toBe(4);
    expect(
      (await f.operator.read("chat"))!.updates.filter((update) => update.status === "needs-Jared"),
    ).toHaveLength(1);
    expect((await f.operator.read("chat"))!.updates.at(-1)?.text).toContain("after three retries");
  });
  it.each([
    {
      type: "runtime.error",
      payload: { class: "provider_error", message: "Usage limit exceeded." },
    },
    { type: "runtime.error", payload: { class: "transport_error", message: "Server overloaded." } },
    {
      type: "turn.completed",
      payload: { state: "interrupted", errorMessage: "Selected model is at capacity." },
    },
  ])(
    "does not capacity-retry unrelated or interrupted failures: $type $payload",
    async ({ type, payload }) => {
      const f = await fixture();
      const job = await f.startOperator();
      await f.operator.event(f.event(job.sessionId!, type, "operator-0", payload));
      await f.operator.drain();
      expect(f.waits).toHaveLength(0);
      expect((await f.operator.read("chat"))!.updates.at(-1)?.status).toBe("needs-Jared");
    },
  );
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
  it.each(["done", "needs-Jared"] as const)(
    "keeps a %s handoff private while sending its saved context to the voice model",
    async (status) => {
      const f = await fixture();
      const text = status === "done" ? "The build passed." : "Which branch should I check?";
      await f.operator.update("chat", "job", "result", status, text);
      await f.operator.announce("chat", "call");
      const command = vi.mocked(f.ports.dispatch).mock.calls.at(-1)![0];
      expect(command.type).toBe("thread.turn.start");
      if (command.type !== "thread.turn.start") throw new Error("Expected an announcement turn.");
      expect(command.message.text).toBe("Background update ready.");
      expect(command.message.text).not.toContain(text);

      // A later receipt must wait for its own announcement.
      await f.operator.update("chat", "later-job", "later", "done", "Another result.");
      const reopened = new CallOperator(f.store);
      reopened.bind(f.ports);
      await reopened.voice({
        threadId: "chat",
        messageId: command.message.messageId,
        text: command.message.text,
        selection: models.voice,
      });
      const voice = (await reopened.read("chat"))!.links.find((link) => link.role === "voice")!;
      await reopened.event(f.event(voice.sessionId, "turn.started", command.message.messageId));
      const providerInput = vi.mocked(f.ports.send).mock.calls.at(-1)![0].input;
      const announcement = providerInput?.split("Operator update at this pause:\n")[1];
      expect(announcement).toContain(JSON.stringify([{ status, text }]));
      expect(announcement).toContain("Do not delegate these updates back to the operator.");
      expect(announcement).not.toContain("Another result.");
      expect(providerInput).toContain("The build in this workspace.");
      await reopened.event(
        f.event(voice.sessionId, "turn.completed", command.message.messageId, {
          state: "completed",
        }),
        '<otis-delegate>{"intent":"Must not delegate announcements"}</otis-delegate>',
      );
      await reopened.drain();
      expect((await reopened.read("chat"))!.jobs).toHaveLength(0);
      expect((await reopened.read("chat"))!.updates[0]?.announcementTurnId).toBe(
        command.message.messageId,
      );
    },
  );
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
