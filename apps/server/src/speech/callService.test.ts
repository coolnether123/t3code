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
