import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type CallOptions, type SpeechResponse } from "@t3tools/contracts";
import { ThreadVoiceSession, type VoiceDependencies } from "./session";
import type { SavedCall } from "@t3tools/client-runtime/voice-call";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const options: CallOptions = {
  threadId: "synthetic",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "synthetic" },
};
const sessions: ThreadVoiceSession[] = [];
function fixture(initial?: SavedCall) {
  const recording = deferred<{ audio: string; sampleRate: number }>();
  const transcript = deferred<SpeechResponse>();
  const waiting = deferred<void>();
  const failed = deferred<void>();
  let saved = initial ? structuredClone(initial) : undefined;
  let captureCount = 0;
  let currentRecording = recording;
  let id = 0;
  const request = vi.fn<VoiceDependencies["request"]>(async (input, signal) => {
    if (input.action === "call.watch")
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    if (input.action === "call.transcribe") return transcript.promise;
    if (input.action === "call.deliver")
      return {
        utterance: {
          id: "u",
          sha256: "hash",
          bytes: 2,
          sampleRate: 16000,
          startedAt: "",
          endedAt: "",
          savedAt: "",
          text: "Go",
          deliveredAt: "now",
        },
      };
    if (input.action === "call.speak") return { audio: "AAA=", sampleRate: 24000 };
    return {};
  });
  const audio = {
    unlock: vi.fn(),
    prepare: vi.fn(async () => {}),
    ready: vi.fn(async () => {}),
    close: vi.fn(),
    finish: vi.fn(() => currentRecording.resolve({ audio: "AAA=", sampleRate: 16000 })),
    capture: vi.fn<VoiceDependencies["audio"]["capture"]>(() => {
      if (captureCount++) currentRecording = deferred();
      return currentRecording.promise;
    }),
    play: vi.fn<VoiceDependencies["audio"]["play"]>(async () => {}),
  };
  const persistence: VoiceDependencies["persistence"] = {
    read: vi.fn(async () => saved),
    write: vi.fn(async (call) => {
      saved = structuredClone(call);
    }),
    clear: vi.fn(async () => {
      saved = undefined;
    }),
  };
  const change = vi.fn<VoiceDependencies["change"]>((state) => {
    if (state === "waiting") waiting.resolve();
    if (state === "reconnecting" || state === "error") failed.resolve();
  });
  const session = new ThreadVoiceSession({
    request,
    audio,
    persistence,
    change,
    id: () => `id-${++id}`,
  });
  sessions.push(session);
  return {
    session,
    request,
    audio,
    persistence,
    change,
    recording,
    transcript,
    waiting,
    failed,
    saved: () => saved,
  };
}
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop();
});

describe("durable thread voice session", () => {
  it("cannot resume capture after hang-up during the ready cue", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const cue = deferred<void>();
    f.audio.ready.mockImplementation(async () => {
      entered.resolve();
      return cue.promise;
    });
    const start = f.session.start(options, []);
    await entered.promise;
    await f.session.stop();
    cue.resolve();
    await start;
    expect(f.audio.capture).not.toHaveBeenCalled();
    expect(f.change).toHaveBeenLastCalledWith("idle", undefined, undefined);
  });
  it("takes the next recording's model from the normal selector and retains it for retries", async () => {
    const f = fixture();
    await f.session.start(options, []);
    const selection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "synthetic-next-model",
    };
    f.session.observe([], false, undefined, selection);
    f.session.finish();
    f.transcript.resolve({ text: "Go" });
    await f.waiting.promise;
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({ action: "call.upload", modelSelection: selection }),
      expect.any(AbortSignal),
    );
  });
  it("journals partial capture, detaches without hang-up and replays it after reload", async () => {
    const f = fixture();
    const journaled = deferred<void>();
    f.audio.capture.mockImplementation(async (_signal, journal) => {
      await journal!({ audio: "AAA=", sampleRate: 16000 });
      journaled.resolve();
      return f.recording.promise;
    });
    await f.session.start(options, []);
    await journaled.promise;
    expect(f.saved()?.recordings[0]?.capturing).toBe(true);
    await f.session.detach();
    const saved = f.saved()!;
    expect(saved.recordings).toHaveLength(1);
    expect(
      f.request.mock.calls.some(
        ([input]) => input.action === "call.close" || input.action === "call.upload",
      ),
    ).toBe(false);
    const reloaded = fixture(saved);
    reloaded.transcript.resolve({ text: "Go" });
    await reloaded.session.start(options, []);
    expect(reloaded.request).toHaveBeenCalledWith(
      expect.objectContaining({ action: "call.upload", utteranceId: saved.recordings[0]!.id }),
      expect.any(AbortSignal),
    );
    expect(reloaded.saved()?.recordings).toEqual([]);
  });
  it("drains a closed call as raw only, then starts a fresh call in the same action", async () => {
    const f = fixture({
      callId: "closed",
      options,
      closed: true,
      offsets: {},
      recordings: [
        { id: "raw", audio: "AAA=", sampleRate: 16000, startedAt: "start", endedAt: "end" },
      ],
    });
    await f.session.start(options, []);
    expect(f.audio.prepare).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.slice(0, 5).map(([input]) => input.action)).toEqual([
      "call.open",
      "call.upload",
      "call.close",
      "call.open",
      "call.prepare",
    ]);
    expect(f.saved()?.callId).not.toBe("closed");
    expect(f.saved()?.recordings).toEqual([]);
    expect(f.request.mock.calls.some(([input]) => input.action === "call.deliver")).toBe(false);
  });
  it("replaces a locally open call that another device has closed", async () => {
    const f = fixture({ callId: "old-device", options, offsets: {}, recordings: [] });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (input, signal) => {
      if (input.action === "call.open" && input.callId === "old-device")
        return {
          call: {
            callId: input.callId,
            threadId: options.threadId,
            version: "closed",
            closed: true,
            ready: false,
            modelSelection: options.modelSelection,
            steps: [],
            utterances: [],
            played: [],
          },
        };
      return original(input, signal);
    });
    await f.session.start(options, []);
    expect(f.saved()?.callId).not.toBe("old-device");
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({ action: "call.prepare", callId: f.saved()?.callId }),
      expect.any(AbortSignal),
    );
    expect(f.audio.capture).toHaveBeenCalledOnce();
  });
  it("retains a late transcript without delivering it after hang-up", async () => {
    const f = fixture();
    const transcribing = deferred<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input, signal) => {
      if (input.action === "call.transcribe") transcribing.resolve();
      return original(input, signal);
    });
    await f.session.start(options, []);
    f.session.finish();
    await transcribing.promise;
    const stop = f.session.stop();
    f.transcript.resolve({ text: "Late" });
    await stop;
    expect(f.request.mock.calls.some(([input]) => input.action === "call.deliver")).toBe(false);
    expect(
      f.request.mock.calls.filter(([input]) => input.action === "call.upload").length,
    ).toBeGreaterThan(0);
  });
  it("never rings or captures after stop during preparation", async () => {
    const f = fixture();
    const prepare = deferred<SpeechResponse>();
    const entered = deferred<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input, signal) => {
      if (input.action === "call.prepare") {
        entered.resolve();
        return prepare.promise;
      }
      return original(input, signal);
    });
    const start = f.session.start(options, []);
    await entered.promise;
    await f.session.stop();
    prepare.resolve({});
    await start;
    expect(f.audio.ready).not.toHaveBeenCalled();
    expect(f.audio.capture).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([input]) => input.action === "call.close")).toBe(true);
  });
  it("speaks new sentence boundaries with bounded IDs and keeps JSON and code silent", async () => {
    const f = fixture();
    await f.session.start(options, []);
    f.session.finish();
    f.transcript.resolve({ text: "Go" });
    await f.waiting.promise;
    const spoken = deferred<void>();
    f.audio.play.mockImplementation(async () => {
      spoken.resolve();
    });
    f.session.observe(
      [
        {
          id: "long".repeat(200),
          role: "assistant",
          text: 'Build passed. ```json\n{"secret":"raw arguments"}\n```',
          streaming: false,
        },
      ],
      true,
    );
    await spoken.promise;
    const requests = f.request.mock.calls
      .map(([input]) => input)
      .filter((input) => input.action === "call.speak");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toBe("Build passed. ");
    expect(requests[0]?.speechId).toMatch(/^s-[a-f0-9]{64}$/);
  });
  it("aborts playback, discards queued speech and silences late deltas from the interrupted turn", async () => {
    const f = fixture();
    await f.session.start(options, []);
    f.session.finish();
    f.transcript.resolve({ text: "Go" });
    await f.waiting.promise;
    const playing = deferred<AbortSignal>();
    f.audio.play.mockImplementation(async (_audio, _rate, signal) => {
      playing.resolve(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const message = {
      id: "reply",
      role: "assistant",
      text: "One. Two.",
      turnId: "turn-1",
      streaming: true,
    };
    f.session.observe([message], true, "turn-1");
    const signal = await playing.promise;
    await f.session.interrupt();
    expect(signal.aborted).toBe(true);
    f.session.observe(
      [
        { ...message, text: "One. Two. Late." },
        { ...message, id: "late-message" },
      ],
      true,
      "turn-1",
    );
    expect(f.request.mock.calls.filter(([input]) => input.action === "call.speak")).toHaveLength(1);
    expect(f.saved()?.silencedTurns).toContain("turn-1");
  });
  it("persists capture before upload and delivers through the server once", async () => {
    const f = fixture();
    await f.session.start(options, []);
    f.session.finish();
    f.transcript.resolve({ text: "Go" });
    await f.waiting.promise;
    const actions = f.request.mock.calls.map(([input]) => input.action);
    expect(actions.filter((action) => action === "call.deliver")).toHaveLength(1);
    expect(actions.indexOf("call.upload")).toBeLessThan(actions.indexOf("call.transcribe"));
    expect(
      vi.mocked(f.persistence.write).mock.calls.some(([call]) => call.recordings.length === 1),
    ).toBe(true);
    expect(f.saved()?.recordings).toEqual([]);
  });
  it("retains capture completing during stop without starting transcription", async () => {
    const f = fixture();
    await f.session.start(options, []);
    await f.session.stop();
    expect(f.request.mock.calls.some(([input]) => input.action === "call.upload")).toBe(true);
    expect(f.request.mock.calls.some(([input]) => input.action === "call.transcribe")).toBe(false);
    expect(f.audio.close).toHaveBeenCalled();
  });
  it("retains a failed upload for retry", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input, signal) => {
      if (input.action === "call.upload") return Promise.reject(new Error("offline"));
      return original(input, signal);
    });
    await f.session.start(options, []);
    f.session.finish();
    await f.failed.promise;
    expect(f.saved()?.recordings).toHaveLength(1);
  });
  it("does not replay assistant history", async () => {
    const f = fixture();
    await f.session.start(options, [
      { id: "old", role: "assistant", text: "History.", streaming: false },
    ]);
    expect(f.request.mock.calls.some(([input]) => input.action === "call.speak")).toBe(false);
  });
  it("does not ring before speech preparation completes", async () => {
    const f = fixture();
    const prepare = deferred<SpeechResponse>();
    const entered = deferred<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input, signal) => {
      if (input.action === "call.prepare") {
        entered.resolve();
        return prepare.promise;
      }
      return original(input, signal);
    });
    const start = f.session.start(options, []);
    await entered.promise;
    expect(f.audio.ready).not.toHaveBeenCalled();
    prepare.resolve({});
    await start;
    expect(f.audio.ready).toHaveBeenCalledTimes(1);
  });
});
