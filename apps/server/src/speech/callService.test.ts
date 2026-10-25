// @effect-diagnostics nodeBuiltinImport:off - Disposable archive fault injection uses real Node files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type CallOptions,
  type CallRequest,
  type ServerProvider,
  type SpeechTransportRequest,
} from "@t3tools/contracts";
import { CallStore, sha256 } from "./callStore.ts";
import { CallOperator } from "./callOperator.ts";
import { CallService, verifyCallModel, type CallPorts } from "./callService.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});
const options: CallOptions = {
  threadId: "synthetic-thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-haiku-5-5",
    options: [{ id: "effort", value: "medium" }],
  },
};
const pcm = Buffer.from([1, 0, 2, 0]);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const upload: CallRequest = {
  action: "call.upload",
  callId: "call-1",
  utteranceId: "utterance-1",
  audio: pcm.toString("base64"),
  sampleRate: 16000,
  startedAt: "2026-10-18T00:00:00.000Z",
  endedAt: "2026-10-18T00:00:01.000Z",
};
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-call-synthetic-"));
  directories.push(directory);
  const store = new CallStore(directory);
  const ports: CallPorts = {
    verify: vi.fn(async () => ({
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
    })),
    dispatch: vi.fn(async () => ({ sequence: 1 })),
    speech: vi.fn(async (input: SpeechTransportRequest) =>
      input.action === "acquire"
        ? { sessionId: "lease-1", tenants: ["stt", "tts"], expiresAt: "2099-10-18T00:00:00.000Z" }
        : input.action === "renew"
          ? { sessionId: "lease-1", tenants: ["stt", "tts"], expiresAt: "2099-10-18T00:01:00.000Z" }
          : input.action === "transcribe"
            ? { text: "Read the build status." }
            : input.action === "speak"
              ? { audio: pcm.toString("base64"), sampleRate: 16000 }
              : {},
    ),
    tenants: ["stt", "tts"],
    ttsModel: "synthetic-tts",
  };
  const service = new CallService(store, ports);
  const request = (input: Omit<CallRequest, "callId">) =>
    service.handle({ callId: "call-1", ...input }, new AbortController().signal);
  await request({ action: "call.open", options });
  await request({ action: "call.prepare" });
  return { store, service, ports, request, directory };
}

describe("durable calls", () => {
  it("reports complete open-call coverage, removes hung-up calls, and fails closed on unavailable archives", async () => {
    const f = await fixture();
    expect(await f.store.openCallSnapshot()).toMatchObject({
      coverage: "complete",
      count: 1,
      openCalls: [{ callId: "call-1", threadId: options.threadId }],
    });
    await f.request({ action: "call.close" });
    expect(await f.store.openCallSnapshot()).toMatchObject({
      coverage: "complete",
      count: 0,
      openCalls: [],
    });
    const unavailable = new CallStore(NodePath.join(f.directory, "not-a-directory"));
    await NodeFSP.writeFile(unavailable.root, "synthetic");
    expect(await unavailable.openCallSnapshot()).toMatchObject({ coverage: "unavailable" });
  });
  it("accumulates PCM across request-scoped services, replaces revisions, and never dispatches partial words", async () => {
    const f = await fixture();
    const request = {
      action: "call.partial" as const,
      callId: "call-1",
      utteranceId: "partial-1",
      audio: pcm.toString("base64"),
      sampleRate: 16000,
      revision: 1,
    };
    const first = await f.service.handle(request, new AbortController().signal);
    expect(first).toEqual({ text: "Read the build status.", revision: 1, transcriptFinal: false });
    const nextService = new CallService(f.store, f.ports);
    const second = await nextService.handle(
      { ...request, revision: 2 },
      new AbortController().signal,
    );
    expect(second.revision).toBe(2);
    const recognition = vi
      .mocked(f.ports.speech)
      .mock.calls.filter(([input]) => input.action === "transcribe");
    expect(Buffer.from(recognition[0]![0].audio!, "base64")).toEqual(pcm);
    expect(Buffer.from(recognition[1]![0].audio!, "base64")).toEqual(Buffer.concat([pcm, pcm]));
    await nextService.handle({ ...request, revision: 2 }, new AbortController().signal);
    expect(
      vi.mocked(f.ports.speech).mock.calls.filter(([input]) => input.action === "transcribe"),
    ).toHaveLength(2);
    await expect(nextService.handle(request, new AbortController().signal)).rejects.toThrow(
      "Stale",
    );
    await nextService.handle(
      { ...request, revision: 3, resetTranscript: true },
      new AbortController().signal,
    );
    const last = vi.mocked(f.ports.speech).mock.calls.at(-1)![0];
    expect(Buffer.from(last.audio!, "base64")).toEqual(pcm);
    expect(f.ports.dispatch).not.toHaveBeenCalled();
  });
  it("caches neutral clips across calls without recording a conversation turn", async () => {
    const f = await fixture();
    const one = await f.request({ action: "call.backchannel", text: "mm" });
    expect(one.audio).toBeTruthy();
    const service = new CallService(f.store, f.ports);
    await service.handle(
      { action: "call.backchannel", callId: "call-1", text: "mm" },
      new AbortController().signal,
    );
    expect(
      vi.mocked(f.ports.speech).mock.calls.filter(([input]) => input.action === "speak"),
    ).toHaveLength(1);
    expect(f.ports.dispatch).not.toHaveBeenCalled();
  });
  it("rejects an overlong listening acknowledgment without creating a turn", async () => {
    const f = await fixture();
    vi.mocked(f.ports.speech).mockResolvedValue({
      audio: Buffer.alloc(48_002).toString("base64"),
      sampleRate: 24_000,
    });
    await expect(f.request({ action: "call.backchannel", text: "mm-hmm" })).rejects.toThrow(
      "too long",
    );
    expect(f.ports.dispatch).not.toHaveBeenCalled();
  });
  it("re-acquires TTS only and delivers after the lease lapses during a stalled watch", async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const stalled = deferred<void>();
    vi.spyOn(f.store, "wait").mockImplementation(async () => {
      entered.resolve();
      await stalled.promise;
    });
    const scheduled = vi.spyOn(f.store, "scheduleExpiry");
    const record = await f.store.require("call-1");
    record.inputMode = "device";
    await f.store.changed(record);
    f.ports.inputMode = vi.fn<NonNullable<CallPorts["inputMode"]>>(async () => "pc");
    const watch = f.request({ action: "call.watch", version: record.version });
    await entered.promise;
    const expired = await f.store.require("call-1");
    expired.leaseUntil = 0;
    await f.store.changed(expired);
    await scheduled.mock.calls.at(-1)![2]();
    expect(await f.service.status("call-1")).toMatchObject({ closed: false, ready: false });
    vi.mocked(f.ports.speech).mockClear();
    vi.mocked(f.ports.speech).mockImplementation(async (input) =>
      input.action === "acquire"
        ? { sessionId: "tts-recovered", tenants: ["tts"], expiresAt: "2099-10-18T00:00:00Z" }
        : {},
    );
    const delivered = await f.request({
      action: "call.say",
      utteranceId: "after-stall",
      text: "Still here",
    });
    expect(delivered.utterance?.deliveredAt).toBeDefined();
    expect(delivered.call).toMatchObject({
      callId: "call-1",
      closed: false,
      ready: true,
      inputMode: "device",
    });
    expect(f.ports.speech).toHaveBeenCalledExactlyOnceWith(
      { action: "acquire", tenants: ["tts"] },
      expect.any(AbortSignal),
    );
    expect(f.ports.inputMode).not.toHaveBeenCalled();
    expect(f.ports.dispatch).toHaveBeenCalledOnce();
    stalled.resolve();
    await watch;
  });
  it("renews from typed activity without requiring a watch", async () => {
    const f = await fixture();
    const record = await f.store.require("call-1");
    record.leaseUntil = Clock.Clock.defaultValue().currentTimeMillisUnsafe() + 30_000;
    record.lastClientAt = Clock.Clock.defaultValue().currentTimeMillisUnsafe() - 500_000;
    await f.store.changed(record);
    await f.request({ action: "call.say", utteranceId: "renewed-typed", text: "Hello" });
    expect(f.ports.speech).toHaveBeenCalledWith(
      { action: "renew", sessionId: "lease-1" },
      expect.any(AbortSignal),
    );
    expect((await f.store.require("call-1")).lastClientAt).toBeGreaterThan(record.lastClientAt);
  });
  it("recovers a recently used legacy archive without treating its expired lease as abandonment", async () => {
    const f = await fixture();
    const record = await f.store.require("call-1");
    delete record.lastClientAt;
    record.createdAt = "2026-01-01T00:00:00Z";
    record.leaseUntil = 0;
    await f.store.changed(record);
    const restarted = new CallService(new CallStore(f.directory), f.ports);
    expect(await restarted.status("call-1")).toMatchObject({ closed: false, ready: false });
    expect((await restarted.store.require("call-1")).lastClientAt).toBeGreaterThan(
      Date.parse(record.createdAt),
    );
  });
  it("keeps a recently contacted call open when only an expired lease timestamp remains", async () => {
    const f = await fixture();
    const record = await f.store.require("call-1");
    delete record.lease;
    record.leaseUntil = 1;
    await f.store.changed(record);
    const restarted = new CallService(new CallStore(f.directory), f.ports);
    expect(await restarted.status("call-1")).toMatchObject({ closed: false, ready: false });
    expect((await restarted.store.require("call-1")).leaseUntil).toBeUndefined();
  });
  it("closes truly abandoned calls after restart through the normal close path", async () => {
    const f = await fixture();
    const record = await f.store.require("call-1");
    record.leaseUntil = 0;
    record.lastClientAt = Clock.Clock.defaultValue().currentTimeMillisUnsafe() - 600_001;
    await f.store.changed(record);
    const other = { ...record, callId: "call-2", threadId: "other-thread", lease: "lease-2" };
    await f.store.changed(other);
    await f.store.write("_threads", `${sha256(other.threadId)}.json`, { callId: other.callId });
    const store = new CallStore(f.directory);
    const restarted = new CallService(store, f.ports);
    vi.mocked(f.ports.speech).mockClear();
    const result = await restarted.handle(
      { action: "call.status", callId: "call-1" },
      new AbortController().signal,
    );
    expect(result.call?.closed).toBe(true);
    for (const call of [record, other]) {
      expect(await store.require(call.callId)).toMatchObject({ closed: true });
      expect((await store.require(call.callId)).lease).toBeUndefined();
      expect(await store.read("_threads", `${sha256(call.threadId)}.json`)).toBeUndefined();
      expect(f.ports.speech).toHaveBeenCalledWith(
        { action: "release", sessionId: call.lease },
        expect.any(AbortSignal),
      );
    }
  });
  it("re-arms cleanup once after restart and keeps a recently contacted call open after lease expiry", async () => {
    const f = await fixture();
    const store = new CallStore(f.directory);
    const scheduled = vi.spyOn(store, "scheduleExpiry");
    const restarted = new CallService(store, f.ports);
    expect(await restarted.status("call-1")).toMatchObject({ closed: false, ready: true });
    const record = await store.require("call-1");
    expect(scheduled).toHaveBeenCalledExactlyOnceWith(
      "call-1",
      record.lastClientAt! + 600_000,
      expect.any(Function),
    );
    await new CallService(store, f.ports).status("call-1");
    expect(scheduled).toHaveBeenCalledTimes(1);
    record.leaseUntil = 0;
    await store.changed(record);
    await scheduled.mock.calls[0]![2]();
    expect(await restarted.status("call-1")).toMatchObject({ closed: false, ready: false });
  });
  it.each(["Lease not found (404)", "Lease expired", "Router unavailable"])(
    "finishes closing after restart when release fails: %s",
    async (message) => {
      const f = await fixture();
      const record = await f.store.require("call-1");
      record.leaseUntil = 0;
      record.lastClientAt = Clock.Clock.defaultValue().currentTimeMillisUnsafe() - 600_001;
      await f.store.changed(record);
      vi.mocked(f.ports.speech).mockRejectedValue(new Error(message));
      const store = new CallStore(f.directory);
      const restarted = new CallService(store, f.ports);
      expect(await restarted.status("call-1")).toMatchObject({ closed: true, ready: false });
      expect((await store.require("call-1")).lease).toBeUndefined();
      expect((await store.require("call-1")).leaseUntil).toBeUndefined();
      expect(await store.activeCall(options.threadId, "")).toBeUndefined();
      expect(await store.read("_threads", `${sha256(options.threadId)}.json`)).toBeUndefined();
    },
  );
  it("finishes an explicit close when releasing speech fails", async () => {
    const f = await fixture();
    vi.mocked(f.ports.speech).mockRejectedValue(new Error("Lease not found (404)"));
    expect((await f.request({ action: "call.close" })).call?.closed).toBe(true);
    expect((await f.store.require("call-1")).lease).toBeUndefined();
  });
  it("replaces a PC lease with TTS-only in device mode and retains the mode across reload", async () => {
    const f = await fixture();
    f.ports.inputMode = async () => "device";
    vi.mocked(f.ports.speech).mockImplementation(async (input) =>
      input.action === "acquire"
        ? { sessionId: "tts-only", tenants: ["tts"], expiresAt: "2099-10-18T00:00:00.000Z" }
        : {},
    );
    await f.request({ action: "call.prepare" });
    expect(f.ports.speech).toHaveBeenLastCalledWith(
      { action: "acquire", tenants: ["tts"] },
      expect.any(AbortSignal),
    );
    const restarted = new CallService(new CallStore(f.directory), f.ports);
    expect(await restarted.status("call-1")).toMatchObject({ ready: true, inputMode: "device" });
    const record = await restarted.store.require("call-1");
    record.leaseUntil = 0;
    await restarted.store.changed(record);
    f.ports.inputMode = vi.fn<NonNullable<CallPorts["inputMode"]>>(async () => "pc");
    vi.mocked(f.ports.speech).mockClear();
    await restarted.handle(
      { action: "call.prepare", callId: "call-1" },
      new AbortController().signal,
    );
    expect(f.ports.speech).toHaveBeenCalledWith(
      { action: "acquire", tenants: ["tts"] },
      expect.any(AbortSignal),
    );
    expect(f.ports.inputMode).not.toHaveBeenCalled();
  });
  it("stops when the router grants STT despite a TTS-only request", async () => {
    const f = await fixture();
    f.ports.inputMode = async () => "device";
    await expect(f.request({ action: "call.prepare" })).rejects.toThrow("cannot grant a TTS-only");
    expect(f.ports.speech).toHaveBeenLastCalledWith(
      { action: "release", sessionId: "lease-1" },
      expect.any(AbortSignal),
    );
  });
  it("retains old recordings without invoking STT in device mode", async () => {
    const f = await fixture();
    await f.service.handle(upload, new AbortController().signal);
    const record = await f.store.require("call-1");
    record.inputMode = "device";
    await f.store.changed(record);
    vi.mocked(f.ports.speech).mockClear();
    await expect(
      f.request({ action: "call.transcribe", utteranceId: upload.utteranceId }),
    ).rejects.toThrow("PC recognition is unavailable");
    expect(f.ports.speech).not.toHaveBeenCalled();
    expect((await f.store.utterance("call-1", upload.utteranceId!)).transcribedAt).toBeUndefined();
  });
  it("runs lease expiry at its deadline and replaces an earlier deadline on renewal", async () => {
    vi.useFakeTimers();
    try {
      const store = new CallStore("synthetic-unused-directory", undefined, {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      });
      const expired = vi.fn(async () => {});
      store.scheduleExpiry(
        "test",
        Clock.Clock.defaultValue().currentTimeMillisUnsafe() + 120_000,
        expired,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      store.scheduleExpiry(
        "test",
        Clock.Clock.defaultValue().currentTimeMillisUnsafe() + 120_000,
        expired,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(expired).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("closes an abandoned call after ten minutes without client contact", async () => {
    const f = await fixture();
    const scheduled = vi.spyOn(f.store, "scheduleExpiry");
    await f.request({ action: "call.renew" });
    const expire = scheduled.mock.calls.at(-1)![2];
    const record = await f.store.require("call-1");
    record.leaseUntil = 0;
    record.lastClientAt = Clock.Clock.defaultValue().currentTimeMillisUnsafe() - 600_001;
    await f.store.changed(record);
    await expire();
    expect((await f.service.status("call-1")).closed).toBe(true);
    expect((await f.store.require("call-1")).lease).toBeUndefined();
    expect(f.ports.speech).toHaveBeenCalledWith(
      { action: "release", sessionId: "lease-1" },
      expect.any(AbortSignal),
    );
    expect(await f.store.activeCall(options.threadId, "")).toBeUndefined();
  });
  it("does not close a call whose lease was extended before an older deadline", async () => {
    const f = await fixture();
    const scheduled = vi.spyOn(f.store, "scheduleExpiry");
    await f.request({ action: "call.renew" });
    await scheduled.mock.calls.at(-1)![2]();
    expect((await f.service.status("call-1")).closed).toBe(false);
    expect(f.ports.speech).not.toHaveBeenCalledWith(
      { action: "release", sessionId: "lease-1" },
      expect.any(AbortSignal),
    );
  });
  it("saves a full minute of 48 kHz PCM without exhausting the validation stack", async () => {
    const f = await fixture();
    const audio = Buffer.alloc(48_000 * 2 * 60, 1);
    const result = await f.request({
      ...upload,
      audio: audio.toString("base64"),
      sampleRate: 48_000,
    });
    expect(result.utterance?.bytes).toBe(audio.length);
    expect(result.utterance?.sha256).toBe(sha256(audio));
  });
  it("does not acknowledge a rejected provider send and retries it on the next delivery", async () => {
    const f = await fixture();
    const operator = new CallOperator(f.store);
    await operator.configure(options.threadId, {
      voice: options.modelSelection,
      operator: { instanceId: ProviderInstanceId.make("codex"), model: "synthetic-operator" },
    });
    const send = vi.fn(async () => ({})).mockRejectedValueOnce(new Error("Provider rejected send"));
    operator.bind({
      context: async () => ({
        cwd: f.directory,
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
      start: async () => ({}),
      sessions: async () => [],
      send,
      dispatch: f.ports.dispatch,
    });
    vi.mocked(f.ports.dispatch).mockImplementation(async (command) => {
      if (command.type !== "thread.turn.start") return {};
      return operator.voice({
        threadId: command.threadId,
        messageId: command.message.messageId,
        text: command.message.text,
        selection: command.modelSelection,
      });
    });
    await f.service.handle(upload, new AbortController().signal);
    await f.request({ action: "call.transcribe", utteranceId: "utterance-1" });
    const service = new CallService(f.store, f.ports, operator);
    const deliver = () =>
      service.handle(
        { action: "call.deliver", callId: "call-1", utteranceId: "utterance-1" },
        new AbortController().signal,
      );
    await expect(deliver()).rejects.toThrow("Provider rejected send");
    expect((await f.store.utterance("call-1", "utterance-1")).deliveredAt).toBeUndefined();
    expect((await deliver()).utterance?.deliveredAt).toBeDefined();
    expect(send).toHaveBeenCalledTimes(2);
    await deliver();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("returns saved call defaults separately from remembered thread models", async () => {
    const f = await fixture();
    const operator = new CallOperator(f.store);
    const defaults = {
      voice: options.modelSelection,
      operator: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    };
    const remembered = { ...defaults, operator: { ...defaults.operator, model: "gpt-5.6-sol" } };
    await operator.configure(options.threadId, defaults, true);
    await operator.configure(options.threadId, remembered);
    const service = new CallService(f.store, f.ports, operator);
    expect(
      await service.handle(
        { action: "call.configure", callId: "settings", options },
        new AbortController().signal,
      ),
    ).toMatchObject({ models: remembered, defaultModels: defaults });
  });
  it("ends an empty rejected open without creating an archive or starting speech", async () => {
    const f = await fixture();
    vi.mocked(f.ports.verify).mockRejectedValueOnce(
      new Error("Open an existing chat before starting a call."),
    );
    const signal = new AbortController().signal;
    const before = vi.mocked(f.ports.speech).mock.calls.length;
    await expect(
      f.service.handle(
        {
          action: "call.open",
          callId: "rejected-call",
          options: { ...options, threadId: "synthetic-draft" },
        },
        signal,
      ),
    ).rejects.toThrow("Open an existing chat");
    expect(await f.store.read("rejected-call", "call.json")).toBeUndefined();
    await expect(
      f.service.handle({ action: "call.close", callId: "rejected-call" }, signal),
    ).resolves.toEqual({});
    expect(vi.mocked(f.ports.speech).mock.calls).toHaveLength(before);
    expect(await f.store.read("rejected-call", "call.json")).toBeUndefined();
  });
  it("renews an attached idle call through its status watch and stops after hang-up", async () => {
    const f = await fixture();
    const record = await f.store.require("call-1");
    record.leaseUntil = Clock.Clock.defaultValue().currentTimeMillisUnsafe() + 59_000;
    await f.store.changed(record);
    const watched = await f.request({ action: "call.watch" });
    expect(watched.call?.ready).toBe(true);
    expect(f.ports.speech).toHaveBeenCalledWith(
      { action: "renew", sessionId: "lease-1" },
      expect.any(AbortSignal),
    );
    await f.request({ action: "call.watch" });
    expect(
      vi.mocked(f.ports.speech).mock.calls.filter(([input]) => input.action === "renew"),
    ).toHaveLength(1);
    await f.request({ action: "call.close" });
    const closed = await f.request({ action: "call.watch" });
    expect(closed.call?.closed).toBe(true);
    expect(
      vi.mocked(f.ports.speech).mock.calls.filter(([input]) => input.action === "renew"),
    ).toHaveLength(1);
  });
  it("streams a sentence before its final chunk and preserves played acknowledgment", async () => {
    const f = await fixture();
    const end = deferred<void>();
    f.ports.speechStream = vi.fn(async function* () {
      yield { audio: "AAA=", sampleRate: 24000 };
      await end.promise;
      yield { audio: "AQA=", sampleRate: 24000 };
    });
    const input = {
      callId: "call-1",
      action: "call.speak" as const,
      speechId: "sentence",
      text: "The work is saved.",
      streamAudio: true,
    };
    const response = f.service.speakStream(input, new AbortController().signal);
    expect((await response.next()).value).toEqual({ audio: "AAA=", sampleRate: 24000 });
    expect(await f.store.read("call-1", "sentence.played.json")).toBeUndefined();
    end.resolve();
    expect((await response.next()).value).toEqual({ audio: "AQA=", sampleRate: 24000 });
    expect((await response.next()).value).toEqual({ complete: true });
    await f.request({ action: "call.played", speechId: "sentence" });
    const replay = [];
    for await (const frame of f.service.speakStream(input, new AbortController().signal))
      replay.push(frame);
    expect(replay).toEqual([{ played: true }, { complete: true }]);
    expect(f.ports.speechStream).toHaveBeenCalledOnce();
  });
  it("waits through the router's full cold-start budget", async () => {
    const f = await fixture();
    const record = await f.store.require("call-1");
    delete record.lease;
    await f.store.changed(record);
    const entered = deferred<void>();
    const engine = deferred<Awaited<ReturnType<CallPorts["speech"]>>>();
    let acquisitionSignal: AbortSignal | undefined;
    f.ports.speech = vi.fn(async (_input, signal) => {
      acquisitionSignal = signal;
      entered.resolve();
      return engine.promise;
    });
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      // @effect-diagnostics-next-line globalTimers:off - Exercise native AbortSignal deadlines with Vitest's fake clock.
      setTimeout(() => controller.abort(new Error("timeout")), ms);
      return controller.signal;
    });
    try {
      const preparing = f.request({ action: "call.prepare" });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(acquisitionSignal?.aborted).toBe(false);
      engine.resolve({
        sessionId: "cold",
        tenants: ["stt", "tts"],
        expiresAt: "2099-10-18T00:00:00Z",
      });
      await preparing;
      expect((await f.service.status("call-1")).ready).toBe(true);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
  it("acknowledges an empty transcript without starting a chat turn", async () => {
    const f = await fixture();
    f.ports.speech = vi.fn(async () => ({ text: "  " }));
    await f.service.handle(upload, new AbortController().signal);
    await f.request({ action: "call.transcribe", utteranceId: "utterance-1" });
    const delivered = await f.request({ action: "call.deliver", utteranceId: "utterance-1" });
    expect(delivered.utterance?.deliveredAt).toBeDefined();
    expect(f.ports.dispatch).not.toHaveBeenCalled();
  });
  it("retains each recording's selected model and rejects a conflicting model on retry", async () => {
    const f = await fixture();
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "synthetic-next" };
    await f.service.handle({ ...upload, modelSelection: selection }, new AbortController().signal);
    await expect(
      f.service.handle(
        { ...upload, modelSelection: options.modelSelection },
        new AbortController().signal,
      ),
    ).rejects.toThrow("different audio or metadata");
    await f.request({ action: "call.transcribe", utteranceId: "utterance-1" });
    await f.request({ action: "call.deliver", utteranceId: "utterance-1" });
    expect(f.ports.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ modelSelection: selection }),
    );
  });
  it("uses ordinary chat permissions and never interrupts the chat on hang-up", async () => {
    const f = await fixture();
    f.ports.verify = vi.fn<CallPorts["verify"]>(async () => ({
      runtimeMode: "approval-required",
      interactionMode: "plan",
    }));
    await f.service.handle(upload, new AbortController().signal);
    await f.request({ action: "call.transcribe", utteranceId: "utterance-1" });
    await f.request({ action: "call.deliver", utteranceId: "utterance-1" });
    expect(f.ports.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeMode: "approval-required" as const,
        interactionMode: "plan" as const,
      }),
    );
    await f.request({ action: "call.close" });
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
    expect((await f.service.status("call-1")).closed).toBe(true);
  });
  it.each(["transcribe", "speak"] as const)(
    "renews, interrupts and closes while %s is stalled",
    async (action) => {
      const f = await fixture();
      await f.service.handle(upload, new AbortController().signal);
      const entered = deferred<void>();
      const engine = deferred<{}>();
      const original = f.ports.speech;
      f.ports.speech = vi.fn(async (input, signal) => {
        if (input.action === action) {
          entered.resolve();
          await engine.promise;
        }
        return original(input, signal);
      });
      const pending = f.request(
        action === "transcribe"
          ? { action: "call.transcribe", utteranceId: "utterance-1" }
          : { action: "call.speak", speechId: "s1", text: "Synthetic response." },
      );
      await entered.promise;
      await f.request({ action: "call.renew" });
      await f.request({ action: "call.interrupt", utteranceId: "interrupt-1" });
      await f.request({ action: "call.close" });
      expect((await f.service.status("call-1")).closed).toBe(true);
      engine.resolve({});
      await pending;
      expect((await f.store.require("call-1")).lease).toBeUndefined();
    },
  );
  it.each(["close", "cancel"])("releases a lease acquired after %s", async (operation) => {
    const f = await fixture();
    const record = await f.store.require("call-1");
    delete record.lease;
    await f.store.changed(record);
    const entered = deferred<void>();
    const engine = deferred<Awaited<ReturnType<CallPorts["speech"]>>>();
    const original = f.ports.speech;
    f.ports.speech = vi.fn((input, signal) => {
      if (input.action === "acquire") {
        entered.resolve();
        return engine.promise;
      }
      return original(input, signal);
    });
    const cancellation = new AbortController();
    const preparation = expect(
      f.service.handle({ callId: "call-1", action: "call.prepare" }, cancellation.signal),
    ).rejects.toThrow(operation === "close" ? "ended" : "cancelled");
    await entered.promise;
    if (operation === "close") await f.request({ action: "call.close" });
    else cancellation.abort(new Error("cancelled"));
    engine.resolve({
      sessionId: "late",
      tenants: ["stt", "tts"],
      expiresAt: "2099-10-18T00:00:00.000Z",
    });
    await preparation;
    expect(f.ports.speech).toHaveBeenLastCalledWith(
      { action: "release", sessionId: "late" },
      expect.any(AbortSignal),
    );
    expect((await f.service.status("call-1")).ready).toBe(false);
  });
  it("invalidates readiness after a failed renewal without extending the lease", async () => {
    const f = await fixture();
    f.ports.speech = vi.fn(async () => {
      throw new Error("Engine lost");
    });
    await expect(f.request({ action: "call.renew" })).rejects.toThrow("Engine lost");
    expect((await f.service.status("call-1")).ready).toBe(false);
  });
  it("repairs an interrupted thread binding and refuses a second active call", async () => {
    const f = await fixture();
    await NodeFSP.rm(NodePath.join(f.directory, "_threads"), { recursive: true });
    const restarted = new CallService(new CallStore(f.directory), f.ports);
    await expect(
      restarted.handle(
        { action: "call.open", callId: "call-2", options },
        new AbortController().signal,
      ),
    ).rejects.toThrow("already has a call");
    await f.request({ action: "call.open", options });
    expect(await f.store.read("_threads", `${sha256(options.threadId)}.json`)).toEqual({
      callId: "call-1",
    });
  });
  it("starts a new call from another device after close, including a stale closed binding", async () => {
    const f = await fixture();
    const binding = `${sha256(options.threadId)}.json`;
    await f.request({ action: "call.close" });
    expect(await f.store.read("_threads", binding)).toBeUndefined();
    // A pre-fix server or interrupted cleanup may have left this index behind.
    await f.store.write("_threads", binding, { callId: "call-1" });
    const restarted = new CallService(new CallStore(f.directory), f.ports);
    const signal = new AbortController().signal;
    const opened = await restarted.handle(
      { action: "call.open", callId: "other-device", options },
      signal,
    );
    expect(opened.call?.closed).toBe(false);
    await restarted.handle({ action: "call.prepare", callId: "other-device" }, signal);
    expect((await restarted.status("other-device")).ready).toBe(true);
    // A retry closing the old archive must preserve the new binding.
    await f.request({ action: "call.close" });
    expect(await f.store.read("_threads", binding)).toEqual({ callId: "other-device" });
  });
  it("can reopen a closed archive to drain raw audio without preparing speech", async () => {
    const f = await fixture();
    await f.request({ action: "call.close" });
    expect((await f.request({ action: "call.open", options })).call?.closed).toBe(true);
    await f.service.handle(upload, new AbortController().signal);
    expect(await NodeFSP.readFile(NodePath.join(f.directory, "call-1", "utterance-1.pcm"))).toEqual(
      pcm,
    );
  });
  it("refuses corrupt saved metadata and never overwrites its raw audio", async () => {
    const f = await fixture();
    await f.service.handle(upload, new AbortController().signal);
    await NodeFSP.writeFile(
      NodePath.join(f.directory, "call-1", "utterance-1.raw.json"),
      '{"id":"utterance-1"}',
    );
    await expect(f.service.handle(upload, new AbortController().signal)).rejects.toThrow(
      "Invalid saved call record",
    );
    expect(await NodeFSP.readFile(NodePath.join(f.directory, "call-1", "utterance-1.pcm"))).toEqual(
      pcm,
    );
  });
  it.each(["upload-intent", "pcm", "raw", "transcript", "intent", "dispatch", "delivery"])(
    "recovers a crash at the %s write boundary",
    async (boundary) => {
      const f = await fixture();
      const original = f.store.writeBytes.bind(f.store);
      let failed = false;
      vi.spyOn(f.store, "writeBytes").mockImplementation(async (callId, name, bytes) => {
        const hit =
          boundary === "upload-intent"
            ? name.endsWith(".upload.json")
            : boundary === "dispatch"
              ? name.endsWith(".dispatch.json")
              : boundary === "pcm"
                ? name.endsWith(".pcm")
                : boundary === "raw"
                  ? name.endsWith(".raw.json")
                  : boundary === "transcript"
                    ? name.endsWith(".transcript.json")
                    : name.endsWith(".delivery.json") &&
                      (boundary === "delivery"
                        ? bytes.toString().includes("deliveredAt")
                        : !bytes.toString().includes("deliveredAt"));
        if (hit && !failed) {
          failed = true;
          throw new Error("synthetic crash");
        }
        return original(callId, name, bytes);
      });
      const accepted = new Set<string>();
      f.ports.dispatch = vi.fn(async (command) => {
        accepted.add(command.commandId);
      });
      try {
        await f.service.handle(upload, new AbortController().signal);
        await f.request({ action: "call.transcribe", utteranceId: "utterance-1" });
        await f.request({ action: "call.deliver", utteranceId: "utterance-1" });
      } catch (error) {
        expect((error as Error).message).toBe("synthetic crash");
      }
      expect(failed).toBe(true);
      const service = new CallService(new CallStore(f.directory), f.ports);
      for (const input of [
        upload,
        { action: "call.transcribe", callId: "call-1", utteranceId: "utterance-1" },
        { action: "call.deliver", callId: "call-1", utteranceId: "utterance-1" },
      ] as const)
        await service.handle(input, new AbortController().signal);
      expect(accepted.size).toBe(1);
      expect(
        await NodeFSP.readFile(NodePath.join(f.directory, "call-1", "utterance-1.pcm")),
      ).toEqual(pcm);
    },
  );
  it("flushes raw PCM before STT and transcript before normal chat dispatch", async () => {
    const f = await fixture();
    const originalSpeech = f.ports.speech;
    f.ports.speech = vi.fn(async (input, signal) => {
      if (input.action === "transcribe") {
        expect(
          await NodeFSP.readFile(NodePath.join(f.directory, "call-1", "utterance-1.pcm")),
        ).toEqual(pcm);
        expect((await f.store.utterance("call-1", "utterance-1")).sha256).toBe(sha256(pcm));
      }
      return originalSpeech(input, signal);
    });
    f.ports.dispatch = vi.fn(async (command) => {
      expect((await f.store.utterance("call-1", "utterance-1")).text).toBe(
        "Read the build status.",
      );
      expect(command.type).toBe("thread.turn.start");
      if (command.type === "thread.turn.start")
        expect(command.modelSelection).toEqual(options.modelSelection);
    });
    const saved = await f.service.handle(upload, new AbortController().signal);
    expect(saved.utterance?.bytes).toBe(4);
    await f.request({ action: "call.transcribe", utteranceId: "utterance-1" });
    await f.request({ action: "call.deliver", utteranceId: "utterance-1" });
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost upload acknowledgment and a lost delivery response with one message identity", async () => {
    const f = await fixture();
    await f.service.handle(upload, new AbortController().signal); // response lost
    const restarted = new CallService(new CallStore(f.directory), f.ports);
    await restarted.handle(upload, new AbortController().signal);
    await f.request({ action: "call.transcribe", utteranceId: "utterance-1" });
    const accepted = new Set<string>();
    let first = true;
    f.ports.dispatch = vi.fn(async (command) => {
      accepted.add(command.commandId);
      if (first) {
        first = false;
        throw new Error("Response lost after commit");
      }
    });
    await expect(f.request({ action: "call.deliver", utteranceId: "utterance-1" })).rejects.toThrow(
      "Response lost",
    );
    const response = await restarted.handle(
      { action: "call.deliver", callId: "call-1", utteranceId: "utterance-1" },
      new AbortController().signal,
    );
    expect(response.utterance?.messageId).toBe("voice:call-1:utterance-1");
    expect(accepted.size).toBe(1);
    await f.request({ action: "call.deliver", utteranceId: "utterance-1" });
    expect(f.ports.dispatch).toHaveBeenCalledTimes(2);
  });
  it("rejects conflicting retry payloads and preserves the original audio", async () => {
    const f = await fixture();
    await f.service.handle(upload, new AbortController().signal);
    await expect(
      f.service.handle({ ...upload, audio: "AwAEAA==" }, new AbortController().signal),
    ).rejects.toThrow("different audio");
    expect(await NodeFSP.readFile(NodePath.join(f.directory, "call-1", "utterance-1.pcm"))).toEqual(
      pcm,
    );
  });
  it("preserves orphaned PCM when metadata persistence did not complete", async () => {
    const f = await fixture();
    await f.store.writeBytes("call-1", "utterance-1.pcm", pcm);
    await expect(
      f.service.handle({ ...upload, audio: "AwAEAA==" }, new AbortController().signal),
    ).rejects.toThrow("will not be overwritten");
    await f.service.handle(upload, new AbortController().signal);
  });
  it("never invokes STT before raw acknowledgment or the agent before a saved transcript", async () => {
    const f = await fixture();
    await expect(f.request({ action: "call.transcribe", utteranceId: "missing" })).rejects.toThrow(
      "Upload",
    );
    await f.service.handle(upload, new AbortController().signal);
    await expect(f.request({ action: "call.deliver", utteranceId: "utterance-1" })).rejects.toThrow(
      "Save the transcript",
    );
    expect(f.ports.dispatch).not.toHaveBeenCalled();
  });
  it("deduplicates simultaneous transcription and delivery retries", async () => {
    const f = await fixture();
    await f.service.handle(upload, new AbortController().signal);
    await Promise.all(
      [1, 2, 3].map(() => f.request({ action: "call.transcribe", utteranceId: "utterance-1" })),
    );
    await Promise.all(
      [1, 2, 3].map(() => f.request({ action: "call.deliver", utteranceId: "utterance-1" })),
    );
    expect(
      vi.mocked(f.ports.speech).mock.calls.filter(([request]) => request.action === "transcribe"),
    ).toHaveLength(1);
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
  });
  it("releases a mismatched GPU profile without reporting ready", async () => {
    const f = await fixture();
    const record = await f.store.require("call-1");
    delete record.lease;
    await f.store.changed(record);
    f.ports.speech = vi.fn(async () => ({ sessionId: "wrong", tenants: ["unrelated-model"] }));
    await expect(f.request({ action: "call.prepare" })).rejects.toThrow("do not match");
    expect(f.ports.speech).toHaveBeenLastCalledWith(
      { action: "release", sessionId: "wrong" },
      expect.any(AbortSignal),
    );
    expect((await f.service.status("call-1")).ready).toBe(false);
  });
  it("retains final offline uploads after close, but never delivers them", async () => {
    const f = await fixture();
    await f.request({ action: "call.close" });
    await f.service.handle(upload, new AbortController().signal);
    await expect(
      f.request({ action: "call.transcribe", utteranceId: "utterance-1" }),
    ).rejects.toThrow("ended");
    expect((await f.service.status("call-1")).utterances).toHaveLength(1);
  });
  it("rejects path traversal and malformed PCM without writing a recording", async () => {
    const f = await fixture();
    await expect(
      f.service.handle({ ...upload, utteranceId: "../escape" }, new AbortController().signal),
    ).rejects.toThrow("ID");
    await expect(
      f.service.handle({ ...upload, audio: "%%%" }, new AbortController().signal),
    ).rejects.toThrow("PCM");
    expect((await f.service.status("call-1")).utterances).toHaveLength(0);
  });
});

describe("exact call model", () => {
  const provider: ServerProvider = {
    instanceId: options.modelSelection.instanceId,
    driver: "claudeAgent" as ServerProvider["driver"],
    enabled: true,
    installed: true,
    version: "synthetic",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-18T00:00:00.000Z",
    models: [
      {
        slug: "claude-haiku-5-5",
        name: "Synthetic Haiku 5.5 configuration",
        isCustom: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              type: "select",
              label: "Thinking",
              options: [{ id: "medium", label: "Medium" }],
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  };
  it("accepts a configured 5.5 model and medium without replacing either", () => {
    expect(() => verifyCallModel(options, [provider])).not.toThrow();
  });
  it("accepts low effort only when the selected model advertises it", () => {
    const low = {
      ...options,
      modelSelection: { ...options.modelSelection, options: [{ id: "effort", value: "low" }] },
    };
    expect(() => verifyCallModel(low, [provider])).toThrow("silently dropped");
    const supported = {
      ...provider,
      models: [
        {
          ...provider.models[0]!,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                type: "select" as const,
                label: "Thinking",
                options: [{ id: "low", label: "Low" }],
              },
            ],
          },
        },
      ],
    };
    expect(() => verifyCallModel(low, [supported])).not.toThrow();
  });
  it.each(["codex", "claudeAgent", "cursor", "grok", "opencode"])(
    "uses the advertised selection with the ordinary %s adapter",
    (driver) => {
      expect(() =>
        verifyCallModel(options, [{ ...provider, driver: ProviderDriverKind.make(driver) }]),
      ).not.toThrow();
    },
  );
  it("refuses an absent model instead of choosing 4.5", () => {
    expect(() =>
      verifyCallModel(options, [
        { ...provider, models: [{ ...provider.models[0]!, slug: "claude-haiku-4-5" }] },
      ]),
    ).toThrow("No fallback");
  });
  it("refuses unsupported thinking instead of dropping it", () => {
    expect(() =>
      verifyCallModel(options, [
        { ...provider, models: [{ ...provider.models[0]!, capabilities: null }] },
      ]),
    ).toThrow("silently dropped");
  });
});

describe("typed call turns", () => {
  it.each([true, false])(
    "delivers a migrated typed turn once when the original delivery acknowledgment exists: %s",
    async (delivered) => {
      const f = await fixture();
      if (delivered)
        await f.request({
          action: "call.say",
          utteranceId: "original-typed",
          text: "Keep my words",
        });
      await f.request({ action: "call.close" });
      const request = (input: Omit<CallRequest, "callId">) =>
        f.service.handle({ ...input, callId: "replacement" }, new AbortController().signal);
      await request({ action: "call.open", options });
      const retryOf = { callId: "call-1", utteranceId: "original-typed" };
      const response = await request({
        action: "call.say",
        utteranceId: "new-typed",
        retryOf,
        text: "Keep my words",
      });
      expect(response.utterance?.deliveredAt).toBeDefined();
      expect(response.utterance?.id).toBe("new-typed");
      await request({
        action: "call.say",
        utteranceId: "another-retry",
        retryOf,
        text: "Keep my words",
      });
      expect(f.ports.dispatch).toHaveBeenCalledOnce();
      expect(f.ports.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ commandId: "voice:call-1:original-typed" }),
      );
    },
  );
  it("rejects delivery on a closed call even when the utterance was delivered before close", async () => {
    const f = await fixture();
    await f.request({ action: "call.say", utteranceId: "before-close", text: "Hello" });
    await f.request({ action: "call.close" });
    await expect(
      f.request({ action: "call.deliver", utteranceId: "before-close" }),
    ).rejects.toThrow("This call has ended");
    expect(f.ports.dispatch).toHaveBeenCalledOnce();
  });
  it("skips STT, uses voice delivery once across recovery, and synthesizes a reply", async () => {
    const f = await fixture();
    const say = {
      action: "call.say" as const,
      callId: "call-1",
      utteranceId: "typed-1",
      text: "Prepare the build",
    };
    const first = await f.service.handle(say, new AbortController().signal);
    const recovered = new CallService(f.store, f.ports);
    const second = await recovered.handle(say, new AbortController().signal);
    expect(second.utterance).toEqual(first.utterance);
    expect(f.ports.dispatch).toHaveBeenCalledOnce();
    expect(f.ports.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "voice:call-1:typed-1",
        message: expect.objectContaining({ text: "Prepare the build" }),
      }),
    );
    expect(
      vi.mocked(f.ports.speech).mock.calls.some(([input]) => input.action === "transcribe"),
    ).toBe(false);
    const reply = await f.request({
      action: "call.speak",
      speechId: "typed-reply",
      text: "I'm ready.",
    });
    expect(reply.audio).toBe(pcm.toString("base64"));
    await expect(f.request({ ...say, text: "Different words" })).rejects.toThrow("identity");
  });
  it("accepts typing while the speech lease is still preparing", async () => {
    const f = await fixture();
    await f.request({ action: "call.close" });
    await f.service.handle(
      { action: "call.open", callId: "cold-call", options },
      new AbortController().signal,
    );
    const result = await f.service.handle(
      { action: "call.say", callId: "cold-call", utteranceId: "cold-typed", text: "Hello" },
      new AbortController().signal,
    );
    expect(result.utterance?.deliveredAt).toBeDefined();
  });
});

it("rejects typing after hang-up without acknowledging or dispatching it", async () => {
  const f = await fixture();
  await f.request({ action: "call.close" });
  await expect(
    f.request({
      action: "call.say",
      utteranceId: "closed-typed",
      text: "Keep these words",
    }),
  ).rejects.toThrow("This call has ended");
  expect(await f.store.read("call-1", "closed-typed.typed.json")).toBeUndefined();
  expect(f.ports.dispatch).not.toHaveBeenCalled();
});
