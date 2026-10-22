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
function fixture(initial?: SavedCall, ensureThread?: VoiceDependencies["ensureThread"]) {
  const recording = deferred<{ audio: string; sampleRate: number }>();
  const transcript = deferred<SpeechResponse>();
  const waiting = deferred<void>();
  const failed = deferred<void>();
  const retrying = deferred<void>();
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
    if (input.action === "call.deliver" || input.action === "call.say")
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
    ready: vi.fn<VoiceDependencies["audio"]["ready"]>(async () => {}),
    close: vi.fn(),
    finish: vi.fn(() => currentRecording.resolve({ audio: "AAA=", sampleRate: 16000 })),
    finishAtPause: vi.fn(),
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
    ...(ensureThread ? { ensureThread } : {}),
    speechEvent: (event) => {
      if (event.type === "retry") retrying.resolve();
    },
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
    retrying,
    saved: () => saved,
  };
}
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop();
  vi.useRealTimers();
});

describe("durable thread voice session", () => {
  it("keeps capture open during speech, ignores echo and acknowledgments, and cancels on sustained recognized barge-in", async () => {
    const f = fixture();
    const playing = deferred<void>();
    const interrupted = deferred<void>();
    const silence = deferred<void>();
    let late: ((value: { audio: string; sampleRate: number }) => void) | undefined;
    let metadata: Parameters<VoiceDependencies["audio"]["play"]>[3];
    const stopPlayback = vi.fn(() => [
      {
        generation: metadata!.generation,
        speechId: metadata!.speechId,
        channel: "reply" as const,
        playedSamples: 12000,
        queuedSamples: 48000,
        sampleRate: 24000,
        stopped: true,
      },
    ]);
    Object.assign(f.audio, { stopPlayback });
    f.audio.play.mockImplementation(async (_audio, _rate, signal, value) => {
      metadata = value;
      playing.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            silence.resolve();
            resolve();
          },
          { once: true },
        ),
      );
    });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (input, signal, audio) => {
      if (input.action === "call.interrupt") interrupted.resolve();
      if (input.action === "call.speak") {
        late = audio;
        audio!({ audio: "AAA=", sampleRate: 24000 });
        return { complete: true };
      }
      return original(input, signal, audio);
    });
    await f.session.start(options, []);
    f.session.observe(
      [
        {
          id: "reply",
          role: "assistant",
          text: "The old answer continues.",
          streaming: false,
          turnId: "old-turn",
        },
      ],
      false,
      "old-turn",
    );
    await playing.promise;
    const hooks = f.audio.capture.mock.calls[0]![2]!;
    expect(f.audio.capture).toHaveBeenCalledOnce();
    expect(f.audio.finish).not.toHaveBeenCalled();
    hooks.activity!(250);
    expect(
      hooks.transcript!({ text: "The old answer continues.", revision: 1, final: false }),
    ).toBe(false);
    expect(hooks.transcript!({ text: "yeah", revision: 2, final: true })).toBe(false);
    expect(f.request.mock.calls.some(([input]) => input.action === "call.interrupt")).toBe(false);
    expect(
      hooks.transcript!({ text: "Wait, check tomorrow instead", revision: 3, final: false }),
    ).toBe(true);
    await silence.promise;
    await interrupted.promise;
    expect(stopPlayback).toHaveBeenCalledOnce();
    const plays = f.audio.play.mock.calls.length;
    expect(() => late!({ audio: "AAA=", sampleRate: 24000 })).toThrow();
    expect(f.audio.play).toHaveBeenCalledTimes(plays);
    expect(f.saved()!.deliveredAudio?.[0]?.playedSamples).toBe(12000);
    expect(f.saved()!.offsets.reply ?? 0).toBe(0);
  });
  it("times out a stuck watch after 35 seconds and retries the same call", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const entered = deferred<void>();
    const retried = deferred<void>();
    const original = f.request.getMockImplementation()!;
    let watches = 0;
    f.request.mockImplementation((input, signal, audio) => {
      if (input.action === "call.watch") {
        if (++watches === 1) entered.resolve();
        else retried.resolve();
        return new Promise(() => {});
      }
      return original(input, signal, audio);
    });
    await f.session.start(options, []);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(35_000);
    await f.retrying.promise;
    await vi.advanceTimersByTimeAsync(250);
    await retried.promise;
    const requests = f.request.mock.calls.filter(([input]) => input.action === "call.watch");
    expect(requests).toHaveLength(2);
    expect(requests[0]![1].aborted).toBe(true);
    expect(requests[1]![0].callId).toBe(requests[0]![0].callId);
    expect(f.request.mock.calls.filter(([input]) => input.action === "call.open")).toHaveLength(1);
  });
  it("automatically moves an undelivered typed turn after a closed-call error and switches all request paths", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    let ended = "";
    let originalUtterance = "";
    const delivered = deferred<void>();
    const switched = deferred<void>();
    const persist = f.persistence.write;
    f.persistence.write = async (saved) => {
      await persist(saved);
      if (ended && saved.callId !== ended && saved.typed?.length === 0) delivered.resolve();
    };
    f.request.mockImplementation(async (input, signal, audio) => {
      if (input.action === "call.watch" && ended && input.callId !== ended) switched.resolve();
      if (input.action === "call.open" || input.action === "call.prepare")
        return {
          call: {
            callId: input.callId,
            threadId: options.threadId,
            version: "1",
            ready: input.callId !== ended,
            closed: input.callId === ended,
            inputMode: "device",
            modelSelection: options.modelSelection,
            steps: [],
            utterances: [],
            played: [],
          },
        };
      if (input.action === "call.say" && !ended) {
        ended = input.callId;
        originalUtterance = input.utteranceId!;
        throw new Error("This call has ended. Its saved speech is retained.");
      }
      return original(input, signal, audio);
    });
    Object.assign(f.audio, { captureText: async () => null });
    await f.session.start(options, []);
    await f.session.say("Do not lose this");
    await delivered.promise;
    await switched.promise;
    const sent = f.request.mock.calls.filter(([input]) => input.action === "call.say");
    expect(sent).toHaveLength(2);
    expect(sent[1]![0]).toMatchObject({
      callId: f.saved()?.callId,
      text: "Do not lose this",
      retryOf: { callId: ended, utteranceId: originalUtterance },
    });
    expect(sent[1]![0].utteranceId).not.toBe(originalUtterance);
    const rejected = f.change.mock.calls.findIndex(([state]) => state === "error");
    expect(f.change.mock.calls.slice(0, rejected).some(([state]) => state === "waiting")).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      f.request.mock.calls
        .filter(([input]) => input.action === "call.renew")
        .every(([input]) => input.callId === f.saved()?.callId),
    ).toBe(true);
    expect(f.request.mock.calls.some(([input]) => input.action === "call.renew")).toBe(true);
    const oldWatch = f.request.mock.calls.find(
      ([input]) => input.action === "call.watch" && input.callId === ended,
    );
    expect(oldWatch?.[1].aborted).toBe(true);
  });
  it("retains recognized device words on hang-up for the next call", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (input, signal, onAudio) =>
      input.action === "call.prepare"
        ? {
            call: {
              callId: "phone",
              threadId: "synthetic",
              version: "1",
              ready: true,
              closed: false,
              inputMode: "device",
              modelSelection: options.modelSelection,
              steps: [],
              utterances: [],
              played: [],
            },
          }
        : original(input, signal, onAudio),
    );
    const captured = deferred<string | null>();
    Object.assign(f.audio, { captureText: () => captured.promise });
    f.audio.close.mockImplementation(() => captured.resolve("Keep these words."));
    await f.session.start(options, []);
    await f.session.stop();
    expect(f.request.mock.calls.some(([input]) => input.action === "call.say")).toBe(false);
    expect(f.saved()).toMatchObject({ closed: true, typed: [{ text: "Keep these words." }] });
  });
  it("delivers device text once through call.say, pauses for the reply, then listens again", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (input, signal, onAudio) =>
      input.action === "call.prepare"
        ? {
            call: {
              callId: "phone",
              threadId: "synthetic",
              version: "1",
              ready: true,
              closed: false,
              inputMode: "device",
              modelSelection: options.modelSelection,
              steps: [],
              utterances: [],
              played: [],
            },
          }
        : original(input, signal, onAudio),
    );
    let captured = deferred<string | null>();
    const captureText = vi.fn(() => captured.promise);
    Object.assign(f.audio, { captureText });
    f.audio.finish.mockImplementation(() => captured.resolve(""));
    f.audio.close.mockImplementation(() => captured.resolve(""));
    await f.session.start(options, []);
    expect(f.audio.prepare).toHaveBeenCalledWith(expect.any(AbortSignal), "device");
    expect(f.audio.capture).not.toHaveBeenCalled();
    captured.resolve("Read my agenda.");
    await f.waiting.promise;
    expect(f.request.mock.calls.filter(([input]) => input.action === "call.say")).toHaveLength(1);
    expect(f.request.mock.calls.find(([input]) => input.action === "call.say")?.[0].text).toBe(
      "Read my agenda.",
    );
    const playback = deferred<void>();
    const talking = deferred<void>();
    const listening = deferred<void>();
    f.audio.play.mockImplementation(() => {
      talking.resolve();
      return playback.promise;
    });
    captured = deferred();
    captureText.mockImplementation(() => {
      listening.resolve();
      return captured.promise;
    });
    f.session.observe(
      [{ id: "reply", role: "assistant", text: "Here is your agenda.", streaming: false }],
      false,
    );
    await talking.promise;
    expect(captureText).toHaveBeenCalledTimes(1);
    playback.resolve();
    await listening.promise;
    expect(captureText).toHaveBeenCalledTimes(2);
    expect(
      f.request.mock.calls.some(
        ([input]) => input.action === "call.upload" || input.action === "call.transcribe",
      ),
    ).toBe(false);
  });
  it("keeps typing available when device recognition is unsupported", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (input, signal, onAudio) =>
      input.action === "call.prepare"
        ? {
            call: {
              callId: "phone",
              threadId: "synthetic",
              version: "1",
              ready: true,
              closed: false,
              inputMode: "device",
              modelSelection: options.modelSelection,
              steps: [],
              utterances: [],
              played: [],
            },
          }
        : original(input, signal, onAudio),
    );
    Object.assign(f.audio, { captureText: vi.fn(async () => null) });
    await f.session.start(options, []);
    expect(f.change).toHaveBeenCalledWith(
      "ready",
      "Voice input is unavailable right now. Type to Otis instead.",
      expect.any(Object),
    );
    await f.session.say("Keep working.");
    await f.waiting.promise;
    expect(f.request.mock.calls.find(([input]) => input.action === "call.say")?.[0].text).toBe(
      "Keep working.",
    );
  });
  it("ends local audio and sends close even when an upload ignores cancellation", async () => {
    const f = fixture();
    const uploading = deferred<void>();
    const release = deferred<SpeechResponse>();
    const closed = deferred<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action === "call.upload") {
        uploading.resolve();
        return release.promise;
      }
      if (input.action === "call.close") closed.resolve();
      return original(input, signal, onAudio);
    });
    await f.session.start(options, []);
    f.session.finish();
    await uploading.promise;
    const stopping = f.session.stop();
    expect(f.audio.close).toHaveBeenCalled();
    expect(f.change.mock.calls.at(-1)?.[0]).toBe("idle");
    await closed.promise;
    expect(f.saved()?.closed).toBe(true);
    release.resolve({});
    await stopping;
    expect(f.request.mock.calls.some(([input]) => input.action === "call.transcribe")).toBe(false);
  });
  it("retries an offline close automatically while remaining ended on the phone", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    let closeCount = 0;
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action === "call.close" && ++closeCount === 1) throw new TypeError("offline");
      return original(input, signal, onAudio);
    });
    await f.session.start(options, []);
    await f.session.stop();
    expect(f.saved()?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(closeCount).toBe(2);
    expect(f.saved()).toBeUndefined();
    expect(f.change.mock.calls.at(-1)?.[0]).toBe("idle");
  });
  it("releases recovery after an interruption during the ready cue", async () => {
    const f = fixture();
    const entered = deferred<void>();
    f.audio.ready.mockImplementationOnce(
      (signal: AbortSignal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          entered.resolve();
        }),
    );
    const start = f.session.start(options, []);
    await entered.promise;
    f.session.audioInterrupted();
    await start;
    await f.session.resume();
    expect(f.audio.ready).toHaveBeenCalledTimes(2);
    expect(f.audio.capture).toHaveBeenCalledOnce();
    f.recording.resolve({ audio: "", sampleRate: 16000 });
    await f.session.stop();
  });
  it("keeps interrupted microphone speech and resumes audio in the retry tap", async () => {
    const f = fixture();
    const retained = deferred<void>();
    const write = f.persistence.write;
    f.persistence.write = async (call) => {
      await write(call);
      if (call.recordings.some((recording) => !recording.capturing)) retained.resolve();
    };
    await f.session.start(options, []);
    f.session.audioInterrupted();
    await retained.promise;
    expect(f.saved()?.recordings).toHaveLength(1);
    expect(f.change).toHaveBeenLastCalledWith(
      "error",
      "Audio paused by the phone. Stop other audio, then tap Retry.",
      undefined,
    );
    f.transcript.resolve({ text: "Go" });
    await f.session.resume(false);
    expect(f.audio.prepare).toHaveBeenCalledOnce();
    const resume = f.session.resume();
    expect(f.audio.unlock).toHaveBeenCalledTimes(2);
    await resume;
    expect(f.saved()?.recordings).toEqual([]);
    expect(f.audio.prepare).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls.filter(([input]) => input.action === "call.upload")).toHaveLength(
      1,
    );
  });
  it("returns to listening when Retry restores an interrupted idle microphone", async () => {
    const f = fixture();
    f.audio.finish.mockImplementationOnce(() =>
      f.recording.resolve({ audio: "", sampleRate: 16000 }),
    );
    await f.session.start(options, []);
    f.session.audioInterrupted();
    await f.session.resume();
    expect(f.audio.prepare).toHaveBeenCalledTimes(2);
    expect(f.audio.capture).toHaveBeenCalledTimes(2);
    expect(f.change.mock.calls.at(-1)?.[0]).toBe("listening");
    expect(f.request.mock.calls.some(([input]) => input.action === "call.upload")).toBe(false);
  });
  it("retries a failed hang-up from the saved-speech action without reopening the call", async () => {
    const f = fixture();
    await f.session.start(options, []);
    f.recording.resolve({ audio: "", sampleRate: 16000 });
    const request = f.request.getMockImplementation()!;
    let failClose = true;
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action === "call.close" && failClose) throw new Error("Close rejected");
      return request(input, signal, onAudio);
    });
    await f.session.stop();
    expect(f.saved()?.closed).toBe(true);
    expect(f.change).toHaveBeenLastCalledWith(
      "idle",
      expect.stringContaining("Call ended"),
      undefined,
    );
    failClose = false;
    await f.session.resume();
    expect(f.saved()).toBeUndefined();
    expect(f.change).toHaveBeenLastCalledWith("idle", "Call ended.", undefined);
    expect(f.request.mock.calls.filter(([input]) => input.action === "call.open")).toHaveLength(1);
    expect(f.audio.capture).toHaveBeenCalledOnce();
  });
  it("unlocks audio in the tap and waits for thread creation before opening with both models", async () => {
    const created = deferred<void>();
    const ensureThread = vi.fn(() => created.promise);
    const f = fixture(undefined, ensureThread);
    const callOptions = {
      ...options,
      operatorSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
    };
    const start = f.session.start(callOptions, []);
    expect(f.audio.unlock).toHaveBeenCalledOnce();
    expect(ensureThread).toHaveBeenCalledWith(callOptions);
    expect(f.request).not.toHaveBeenCalled();
    created.resolve();
    await start;
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({
      action: "call.open",
      options: callOptions,
    });
  });
  it("closes after thread creation fails without opening a call or retaining recovery UI", async () => {
    const f = fixture(undefined, async () => {
      throw new Error("Thread creation failed.");
    });
    await f.session.start(options, []);
    expect(f.change).toHaveBeenLastCalledWith(
      "error",
      expect.stringContaining("Thread creation failed."),
      undefined,
    );
    await f.session.stop();
    expect(f.change).toHaveBeenLastCalledWith("idle", "Call ended.", undefined);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("clears an empty rejected open after idempotent server close", async () => {
    const f = fixture();
    f.request.mockImplementation(async (input) => {
      if (input.action === "call.open")
        throw new Error("Open an existing chat before starting a call.");
      if (input.action === "call.close") return {};
      throw new Error("Unexpected call action");
    });
    await f.session.start(options, []);
    await f.session.stop();
    expect(f.saved()).toBeUndefined();
    expect(f.change).toHaveBeenLastCalledWith("idle", "Call ended.", undefined);
    expect(f.request.mock.calls.map(([input]) => input.action)).toEqual([
      "call.open",
      "call.close",
    ]);
  });
  it("keeps a slow undecided turn silent until the model starts a spoken reply", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start(options, []);
    f.session.finish();
    f.session.finish();
    await vi.advanceTimersByTimeAsync(1_800);
    f.transcript.resolve({});
    await f.waiting.promise;
    expect(f.audio.play).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([input]) => input.action === "call.speak")).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.audio.play).not.toHaveBeenCalled();
  });

  it("does not play filler for an automatically submitted hold turn", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start(options, []);
    f.recording.resolve({ audio: "AAA=", sampleRate: 16_000 });
    await vi.advanceTimersByTimeAsync(1_800);
    f.transcript.resolve({});
    await f.waiting.promise;
    f.session.observe(
      [{ id: "hold", role: "assistant", text: "<otis-hold/>", streaming: false }],
      false,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.audio.play).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([input]) => input.action === "call.speak")).toBe(false);
    expect(f.change.mock.calls.at(-1)?.[0]).toBe("listening");
  });

  it.each([
    { text: '<otis-delegate>{"intent":"Check"}</otis-delegate>' },
    { text: '<otis-hold/><otis-delegate>{"intent":"Check"}</otis-delegate>' },
    { text: "", voiceDelegation: true },
  ])("immediately acknowledges a delegation without prose: %j", async (reply) => {
    vi.useFakeTimers();
    const f = fixture();
    const ended = deferred<void>();
    f.audio.play.mockImplementationOnce(() => ended.promise);
    await f.session.start(options, []);
    f.transcript.resolve({});
    f.session.finish();
    await f.waiting.promise;
    const messages = [{ id: "delegate", role: "assistant", streaming: false, ...reply }];
    f.session.observe(messages, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.audio.play).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.some(([input]) => input.action === "call.speak")).toBe(false);
    expect(f.audio.capture).toHaveBeenCalledTimes(1);
    f.session.observe(messages, false);
    ended.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.audio.capture).toHaveBeenCalledTimes(2);
    f.session.finish();
    await vi.advanceTimersByTimeAsync(0);
    f.session.observe(messages, false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.audio.play).toHaveBeenCalledTimes(1);
  });

  it("keeps a quick spoken reply filler-free", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const playing = deferred<void>();
    f.audio.play.mockImplementationOnce(async () => playing.resolve());
    await f.session.start(options, []);
    f.transcript.resolve({});
    f.session.finish();
    await f.waiting.promise;
    f.session.observe(
      [{ id: "quick", role: "assistant", text: "The task is open.", streaming: false }],
      false,
    );
    await playing.promise;
    expect(f.audio.play.mock.calls.map(([audio]) => audio)).toEqual(["AAA="]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.audio.play).toHaveBeenCalledTimes(1);
  });

  it("waits for the filler before playing the voice reply in the same call", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const finishFiller = deferred<void>();
    const synthesis = deferred<void>();
    const replyPlaying = deferred<void>();
    f.audio.play.mockImplementationOnce(async () => finishFiller.promise);
    f.audio.play.mockImplementationOnce(async () => {
      replyPlaying.resolve();
    });
    const original = f.request.getMockImplementation()!;
    const allowSynthesis = deferred<void>();
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action === "call.speak") {
        synthesis.resolve();
        await allowSynthesis.promise;
      }
      return original(input, signal, onAudio);
    });
    await f.session.start(options, []);
    f.transcript.resolve({});
    f.session.finish();
    await f.waiting.promise;
    await vi.advanceTimersByTimeAsync(1_800);
    f.session.observe(
      [{ id: "reply", role: "assistant", text: "Checking your task.", streaming: false }],
      true,
      "voice-turn",
    );
    await synthesis.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.audio.play).toHaveBeenCalledTimes(1);
    expect(f.audio.play.mock.calls[0]![2].aborted).toBe(false);
    finishFiller.resolve();
    allowSynthesis.resolve();
    await replyPlaying.promise;
    expect(f.audio.play).toHaveBeenCalledTimes(2);
    expect(f.audio.play.mock.calls[1]![0]).toBe("AAA=");
  });

  it("does not arm filler for silence or for a status-only pause", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start(options, []);
    f.recording.resolve({ audio: "", sampleRate: 16_000 });
    f.session.observe([], false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.audio.play).not.toHaveBeenCalled();
  });

  it("cancels the filler timer when the call hangs up", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start(options, []);
    f.transcript.resolve({});
    f.session.finish();
    await f.waiting.promise;
    await f.session.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.audio.play).not.toHaveBeenCalled();
  });

  it.each(["\n\n", "\n\n#_*"])(
    "handles a silent trailing fragment %j without another synthesis or an incomplete heard acknowledgment",
    async (suffix) => {
      const f = fixture();
      const text = `The task is open.${suffix}`;
      const playing = deferred<void>();
      const finishPlayback = deferred<void>();
      const heard = deferred<void>();
      const persisted = deferred<void>();
      const originalWrite = vi.mocked(f.persistence.write).getMockImplementation()!;
      vi.mocked(f.persistence.write).mockImplementation(async (call) => {
        await originalWrite(call);
        if (call.offsets.reply === text.length) persisted.resolve();
      });
      f.audio.play.mockImplementation(async () => {
        playing.resolve();
        await finishPlayback.promise;
      });
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (input, signal, onAudio) => {
        if (input.action === "call.prepare")
          return {
            call: {
              callId: f.saved()!.callId,
              threadId: options.threadId,
              version: "result",
              ready: true,
              closed: false,
              modelSelection: options.modelSelection,
              steps: [],
              utterances: [],
              played: [],
              operatorUpdates: [
                {
                  id: "result",
                  jobId: "job",
                  status: "done",
                  text: "The task is open.",
                  createdAt: "2026-10-18T00:00:00Z",
                  announcementId: "announcement",
                  announcementTurnId: "result-turn",
                },
              ],
            },
          };
        if (input.action === "call.heard") heard.resolve();
        return original(input, signal, onAudio);
      });
      await f.session.start(options, []);
      f.session.observe(
        [{ id: "reply", role: "assistant", text, streaming: false, turnId: "result-turn" }],
        false,
        "result-turn",
      );
      f.recording.resolve({ audio: "", sampleRate: 16000 });
      await playing.promise;
      expect(f.saved()!.offsets.reply ?? 0).toBe(0);
      expect(f.request.mock.calls.some(([input]) => input.action === "call.heard")).toBe(false);
      finishPlayback.resolve();
      await heard.promise;
      await persisted.promise;
      const requests = f.request.mock.calls.filter(([input]) => input.action === "call.speak");
      expect(requests).toHaveLength(1);
      expect(requests[0]![0].text?.trim()).toBe("The task is open.");
      expect(f.saved()!.offsets.reply).toBe(text.length);
      expect(
        f.change.mock.calls.some(([state]) => state === "error" || state === "reconnecting"),
      ).toBe(false);
    },
  );
  it("keeps a permanent speech error visible instead of retrying it", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action === "call.speak") throw new Error("Synthetic invalid speech configuration");
      return original(input, signal, onAudio);
    });
    await f.session.start(options, []);
    f.session.observe([{ id: "reply", role: "assistant", text: "Done.", streaming: false }], true);
    f.recording.resolve({ audio: "", sampleRate: 16000 });
    await f.failed.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.request.mock.calls.filter(([input]) => input.action === "call.speak")).toHaveLength(1);
    expect(f.change.mock.calls.at(-1)?.[0]).toBe("error");
  });
  it("retries a failed status watch without aborting streaming playback or dropping the next sentence", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const failWatch = deferred<void>();
    const playing = deferred<void>();
    const playbackEnd = deferred<void>();
    const secondPlayed = deferred<void>();
    const original = f.request.getMockImplementation()!;
    let watchAttempt = 0;
    let played = 0;
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action === "call.watch" && watchAttempt++ === 0) {
        await failWatch.promise;
        throw Object.assign(new Error("Synthetic endpoint failure"), {
          _tag: "RemoteEnvironmentAuthFetchError",
        });
      }
      if (input.action === "call.speak") {
        onAudio!({ audio: "AAA=", sampleRate: 24000 });
        return { complete: true };
      }
      if (input.action === "call.played" && ++played === 2) secondPlayed.resolve();
      return original(input, signal, onAudio);
    });
    let playbackSignal: AbortSignal | undefined;
    f.audio.play.mockImplementation(async (_audio, _rate, signal) => {
      if (playbackSignal) return;
      playbackSignal = signal;
      playing.resolve();
      await playbackEnd.promise;
    });
    await f.session.start(options, []);
    f.session.observe(
      [{ id: "reply", role: "assistant", text: "First. Second.", streaming: false }],
      true,
    );
    f.recording.resolve({ audio: "", sampleRate: 16000 });
    await playing.promise;
    failWatch.resolve();
    await f.retrying.promise;
    expect(playbackSignal!.aborted).toBe(false);
    expect(
      f.change.mock.calls.some(([state]) => state === "error" || state === "reconnecting"),
    ).toBe(false);
    playbackEnd.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await secondPlayed.promise;
    expect(
      f.request.mock.calls
        .filter(([input]) => input.action === "call.speak")
        .map(([input]) => input.text),
    ).toEqual(["First. ", "Second."]);
    expect(watchAttempt).toBe(2);
  });
  it("retries a lost played acknowledgment without synthesizing or playing the sentence twice", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const acknowledged = deferred<void>();
    const original = f.request.getMockImplementation()!;
    let attempts = 0;
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action === "call.played") {
        if (++attempts === 1) throw new TypeError("Synthetic acknowledgment reset");
        acknowledged.resolve();
      }
      return original(input, signal, onAudio);
    });
    await f.session.start(options, []);
    f.session.observe([{ id: "reply", role: "assistant", text: "Done.", streaming: false }], true);
    f.recording.resolve({ audio: "", sampleRate: 16000 });
    await f.retrying.promise;
    await vi.advanceTimersByTimeAsync(250);
    await acknowledged.promise;
    expect(f.audio.play).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.filter(([input]) => input.action === "call.speak")).toHaveLength(1);
  });
  it("cancels partial playback before retrying the same failed synthesis", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const acknowledged = deferred<void>();
    const original = f.request.getMockImplementation()!;
    let attempts = 0;
    let partial: AbortSignal | undefined;
    f.audio.play.mockImplementation(async (_audio, _rate, signal) => {
      if (partial) return;
      partial = signal;
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action === "call.speak" && ++attempts === 1) {
        onAudio!({ audio: "AAA=", sampleRate: 24000 });
        throw new TypeError("Synthetic stream reset");
      }
      if (input.action === "call.played") acknowledged.resolve();
      return original(input, signal, onAudio);
    });
    await f.session.start(options, []);
    f.session.observe([{ id: "reply", role: "assistant", text: "Done.", streaming: false }], true);
    f.recording.resolve({ audio: "", sampleRate: 16000 });
    await f.retrying.promise;
    expect(partial!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    await acknowledged.promise;
    const requests = f.request.mock.calls.filter(([input]) => input.action === "call.speak");
    expect(requests).toHaveLength(2);
    expect(requests[0]![0].speechId).toBe(requests[1]![0].speechId);
  });
  it.each(["stop", "detach", "interrupt"] as const)(
    "cancels pending speech retries on %s even after an online event",
    async (action) => {
      vi.useFakeTimers();
      const f = fixture();
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (input, signal, onAudio) => {
        if (input.action === "call.speak") throw new TypeError("Synthetic offline endpoint");
        return original(input, signal, onAudio);
      });
      await f.session.start(options, []);
      f.session.observe(
        [{ id: "reply", role: "assistant", text: "Done.", streaming: false }],
        true,
      );
      f.recording.resolve({ audio: "", sampleRate: 16000 });
      await f.retrying.promise;
      await f.session.resume();
      expect(
        f.request.mock.calls.filter(([input]) => input.action === "call.prepare"),
      ).toHaveLength(1);
      await f.session[action]();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.request.mock.calls.filter(([input]) => input.action === "call.speak")).toHaveLength(
        1,
      );
    },
  );
  it("announces a result arriving during acknowledgment playback before reopening the microphone", async () => {
    const f = fixture();
    const watch = deferred<SpeechResponse>();
    const playing = deferred<void>();
    const playbackEnd = deferred<void>();
    const updateReceived = deferred<void>();
    const announced = deferred<void>();
    f.audio.play.mockImplementation(async () => {
      playing.resolve();
      await playbackEnd.promise;
    });
    const originalChange = f.change.getMockImplementation()!;
    f.change.mockImplementation((state, detail, call) => {
      originalChange(state, detail, call);
      if (call?.operatorUpdates?.length) updateReceived.resolve();
    });
    const original = f.request.getMockImplementation()!;
    let watching = false;
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action === "call.watch" && !watching) {
        watching = true;
        return watch.promise;
      }
      if (input.action === "call.announce") {
        announced.resolve();
        return { announced: true };
      }
      return original(input, signal, onAudio);
    });
    await f.session.start(options, []);
    const reply = { id: "ack", role: "assistant", text: "Checking it.", streaming: false };
    f.session.observe([reply], true, "voice-turn");
    f.recording.resolve({ audio: "", sampleRate: 16000 });
    await playing.promise;
    watch.resolve({
      call: {
        callId: f.saved()!.callId,
        threadId: options.threadId,
        version: "result",
        ready: true,
        closed: false,
        modelSelection: options.modelSelection,
        steps: [],
        utterances: [],
        played: [],
        operatorUpdates: [
          {
            id: "done",
            jobId: "job",
            status: "done",
            text: "Task is open.",
            createdAt: "2026-10-18T00:00:00Z",
          },
        ],
      },
    });
    await updateReceived.promise;
    f.session.observe([reply], false, "voice-turn");
    expect(f.request.mock.calls.some(([input]) => input.action === "call.announce")).toBe(false);
    playbackEnd.resolve();
    await announced.promise;
    expect(f.audio.capture).toHaveBeenCalledTimes(1);
  });
  it("renews the whole call across voice completion, operator waits and a recoverable error", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start(options, []);
    f.session.observe([], true, "voice-turn");
    await vi.advanceTimersByTimeAsync(60_000);
    f.session.observe([], false, "voice-turn");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.request.mock.calls.filter(([input]) => input.action === "call.renew")).toHaveLength(2);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action === "call.renew") throw new TypeError("Synthetic disconnection");
      return original(input, signal, onAudio);
    });
    f.transcript.resolve({});
    await vi.advanceTimersByTimeAsync(60_000);
    await f.retrying.promise;
    f.request.mockImplementation(original);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.request.mock.calls.filter(([input]) => input.action === "call.renew")).toHaveLength(4);
    expect(
      f.change.mock.calls.some(([state]) => state === "error" || state === "reconnecting"),
    ).toBe(false);
    await f.session.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.request.mock.calls.filter(([input]) => input.action === "call.renew")).toHaveLength(4);
  });
  it("cancels renewal when detached without stopping background work", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start(options, []);
    await f.session.detach();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.request.mock.calls.some(([input]) => input.action === "call.renew")).toBe(false);
    expect(f.request.mock.calls.some(([input]) => input.action === "call.interrupt")).toBe(false);
  });
  it("plays a queued reply at an idle microphone pause and removes journaled silence", async () => {
    const f = fixture();
    const capture = deferred<{ audio: string; sampleRate: number }>();
    const journaled = deferred<void>();
    f.audio.capture.mockImplementation(async (_signal, journal) => {
      await journal!({ audio: "AAA=", sampleRate: 16000 });
      journaled.resolve();
      return capture.promise;
    });
    const played = deferred<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action === "call.played") played.resolve();
      return original(input, signal, onAudio);
    });
    await f.session.start(options, []);
    await journaled.promise;
    f.session.observe(
      [{ id: "reply", role: "assistant", text: "The task is open.", streaming: false }],
      true,
    );
    expect(f.audio.play).not.toHaveBeenCalled();
    capture.resolve({ audio: "", sampleRate: 16000 });
    await played.promise;
    expect(f.saved()!.recordings).toEqual([]);
    expect(f.request.mock.calls.some(([input]) => input.action === "call.upload")).toBe(false);
  });
  it.each(["done", "needs-Jared"] as const)(
    "holds an operator %s during speech, retries its voice reply and acknowledges it only after playback",
    async (updateStatus) => {
      vi.useFakeTimers();
      const f = fixture();
      const watch = deferred<SpeechResponse>();
      const pause = deferred<void>();
      const announced = deferred<void>();
      const played = deferred<void>();
      const heard = deferred<void>();
      f.audio.finishAtPause.mockImplementation(() => {
        pause.resolve();
      });
      const original = f.request.getMockImplementation()!;
      let watching = false;
      let synthesisFailed = false;
      const update = {
        id: "result",
        jobId: "job",
        status: updateStatus,
        text: "Build passed.",
        createdAt: "2026-10-18T00:00:00Z",
      };
      const status = () => ({
        callId: f.saved()!.callId,
        threadId: options.threadId,
        version: "v2",
        ready: true,
        closed: false,
        modelSelection: options.modelSelection,
        steps: [],
        utterances: [],
        played: [],
        operatorUpdates: [update],
      });
      f.request.mockImplementation(async (input, signal, onAudio) => {
        if (input.action === "call.speak" && !synthesisFailed) {
          synthesisFailed = true;
          throw new TypeError("Synthetic fetch failure");
        }
        if (input.action === "call.watch" && !watching) {
          watching = true;
          return watch.promise;
        }
        if (input.action === "call.announce") {
          announced.resolve();
          return {
            announced: true,
            call: {
              ...status(),
              operatorUpdates: [
                { ...update, announcementId: "voice-update", announcementTurnId: "update-turn" },
              ],
            },
          };
        }
        if (input.action === "call.played") played.resolve();
        if (input.action === "call.heard") heard.resolve();
        return original(input, signal, onAudio);
      });
      await f.session.start(options, []);
      watch.resolve({ call: status() });
      await pause.promise;
      expect(f.request.mock.calls.some(([input]) => input.action === "call.announce")).toBe(false);
      expect(f.audio.play).not.toHaveBeenCalled();
      f.recording.resolve({ audio: "", sampleRate: 16000 });
      await announced.promise;
      const reply = {
        id: "update-reply",
        role: "assistant",
        text: "The build passed.",
        streaming: false,
        turnId: "update-turn",
      };
      f.session.observe([reply], true, "update-turn");
      await f.retrying.promise;
      await vi.advanceTimersByTimeAsync(250);
      await played.promise;
      expect(f.request.mock.calls.some(([input]) => input.action === "call.heard")).toBe(false);
      f.session.observe([reply], false, "update-turn");
      await heard.promise;
      expect(f.request).toHaveBeenCalledWith(
        expect.objectContaining({ action: "call.heard", updateIds: ["result"] }),
        expect.any(AbortSignal),
      );
    },
  );
  it("plays streamed PCM before synthesis ends and drops queued sentences on interrupt", async () => {
    const f = fixture();
    await f.session.start(options, []);
    f.session.finish();
    f.transcript.resolve({ text: "Go" });
    await f.waiting.promise;
    const synthesized = deferred<void>();
    const playing = deferred<void>();
    const original = f.request.getMockImplementation()!;
    let sendChunk: ((chunk: { audio: string; sampleRate: number }) => void) | undefined;
    f.audio.play.mockImplementation(async () => {
      playing.resolve();
    });
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action !== "call.speak") return original(input, signal, onAudio);
      sendChunk = onAudio;
      onAudio!({ audio: "AAA=", sampleRate: 24000 });
      await synthesized.promise;
      return { complete: true };
    });
    const message = {
      id: "reply",
      role: "assistant",
      text: "First sentence. Second sentence. Third sentence. Fourth sentence.",
      streaming: true,
      turnId: "turn",
    };
    f.session.observe([message], true, "turn");
    await playing.promise;
    expect(
      f.request.mock.calls
        .filter(([input]) => input.action === "call.speak")
        .map(([input]) => input.text),
    ).toEqual(["First sentence. "]);
    const interrupt = f.session.interrupt();
    expect(() => sendChunk!({ audio: "AAA=", sampleRate: 24000 })).toThrow();
    synthesized.resolve();
    await interrupt;
    f.session.observe([{ ...message, streaming: false }], false, "turn");
    expect(f.request.mock.calls.filter(([input]) => input.action === "call.speak")).toHaveLength(1);
  });
  it("refills the short ordered sentence queue without dropping the rest of a completed reply", async () => {
    const f = fixture();
    await f.session.start(options, []);
    f.session.finish();
    f.transcript.resolve({ text: "Go" });
    await f.waiting.promise;
    const done = deferred<void>();
    const original = f.request.getMockImplementation()!;
    let count = 0;
    f.request.mockImplementation(async (input, signal, onAudio) => {
      const response = await original(input, signal, onAudio);
      if (input.action === "call.played" && ++count === 5) done.resolve();
      return response;
    });
    f.session.observe(
      [{ id: "reply", role: "assistant", text: "One. Two. Three. Four. Five.", streaming: false }],
      true,
    );
    await done.promise;
    expect(
      f.request.mock.calls
        .filter(([input]) => input.action === "call.speak")
        .map(([input]) => input.text),
    ).toEqual(["One. ", "Two. ", "Three. ", "Four. ", "Five."]);
  });
  it("delivers microphone input retained during a reply after playback and turn completion", async () => {
    const f = fixture();
    const playing = deferred<void>();
    const finishPlayback = deferred<void>();
    const delivered = deferred<void>();
    f.audio.play.mockImplementation(async () => {
      playing.resolve();
      await finishPlayback.promise;
    });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (input, signal) => {
      const result = await original(input, signal);
      if (input.action === "call.deliver") delivered.resolve();
      return result;
    });
    await f.session.start(options, []);
    const reply = {
      id: "reply",
      role: "assistant",
      text: "The work is saved.",
      streaming: false,
      turnId: "turn",
    };
    f.session.observe([reply], true, "turn");
    expect(f.audio.play).not.toHaveBeenCalled();
    f.session.finish();
    await playing.promise;
    expect(f.saved()?.recordings).toHaveLength(1);
    f.session.observe([reply], false, "turn");
    f.transcript.resolve({ text: "Go" });
    finishPlayback.resolve();
    await delivered.promise;
    const actions = f.request.mock.calls.map(([input]) => input.action);
    expect(actions.indexOf("call.played")).toBeLessThan(actions.indexOf("call.transcribe"));
    expect(f.audio.capture).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    "queues an incoming reply until the microphone reaches a pause, streaming=%s",
    async (streaming) => {
      const f = fixture();
      const played = deferred<void>();
      f.audio.play.mockImplementation(async () => {
        played.resolve();
      });
      await f.session.start(options, []);
      f.session.observe(
        [
          {
            id: "reply",
            role: "assistant",
            text: "The call task is open. I saved the details in the chat.",
            streaming,
            turnId: "turn",
          },
        ],
        true,
        "turn",
      );
      expect(f.audio.finishAtPause).toHaveBeenCalledOnce();
      expect(f.audio.finish).not.toHaveBeenCalled();
      expect(f.audio.play).not.toHaveBeenCalled();
      f.session.finish();
      await played.promise;
      expect(f.request).toHaveBeenCalledWith(
        expect.objectContaining({ action: "call.upload" }),
        expect.any(AbortSignal),
      );
      expect(f.request.mock.calls.some(([input]) => input.action === "call.deliver")).toBe(false);
      expect(f.saved()?.recordings).toHaveLength(1);
      expect(f.request).toHaveBeenCalledWith(
        expect.objectContaining({ action: "call.speak", text: "The call task is open. " }),
        expect.any(AbortSignal),
        expect.any(Function),
      );
    },
  );
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
    expect(f.change).toHaveBeenLastCalledWith("idle", "Call ended.", undefined);
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
      "call.close",
      "call.upload",
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

it("saves a typed turn during preparation and plays its voice reply", async () => {
  const f = fixture();
  const preparing = deferred<void>();
  const release = deferred<SpeechResponse>();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation((input, signal, audio) => {
    if (input.action === "call.prepare") {
      preparing.resolve();
      return release.promise;
    }
    return original(input, signal, audio);
  });
  const starting = f.session.start(options, []);
  await preparing.promise;
  await f.session.say("Hello from the keyboard");
  expect(f.request.mock.calls.filter(([input]) => input.action === "call.say")).toHaveLength(1);
  expect(f.request.mock.calls.some(([input]) => input.action === "call.transcribe")).toBe(false);
  release.resolve({});
  await starting;
  const spoken = deferred<void>();
  f.audio.play.mockImplementation(async () => {
    spoken.resolve();
  });
  f.session.observe(
    [{ id: "voice-reply:typed", role: "assistant", text: "Hello Jared.", streaming: false }],
    false,
  );
  await spoken.promise;
  expect(f.request.mock.calls.find(([input]) => input.action === "call.speak")?.[0].text).toBe(
    "Hello Jared.",
  );
  expect(f.saved()?.typed).toEqual([]);
});

it("recovers a typed outbox with the same delivery ID", async () => {
  const f = fixture({
    callId: "saved-typed",
    options,
    recordings: [],
    offsets: {},
    typed: [{ id: "stable-typed", text: "Saved words", modelSelection: options.modelSelection }],
  });
  await f.session.start(options, []);
  expect(
    f.request.mock.calls
      .filter(([input]) => input.action === "call.say")
      .map(([input]) => input.utteranceId),
  ).toEqual(["stable-typed"]);
  expect(f.saved()?.typed).toEqual([]);
});

it("speaks a slow-start ready line only once within a call", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.session.observe([], true);
  const preparing = deferred<void>();
  const release = deferred<SpeechResponse>();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation((input, signal, audio) => {
    if (input.action === "call.prepare") {
      preparing.resolve();
      return release.promise;
    }
    return original(input, signal, audio);
  });
  const starting = f.session.start(options, []);
  await preparing.promise;
  await vi.advanceTimersByTimeAsync(4500);
  release.resolve({});
  await starting;
  expect(
    f.request.mock.calls.filter(
      ([input]) => input.action === "call.speak" && input.text === "I'm here.",
    ),
  ).toHaveLength(1);
  const callId = f.saved()?.callId;
  f.session.audioInterrupted();
  await f.session.resume();
  expect(f.saved()?.callId).toBe(callId);
  expect(
    f.request.mock.calls
      .filter(([input]) => input.action === "call.prepare")
      .every(([input]) => input.callId === callId),
  ).toBe(true);
  expect(
    f.request.mock.calls.filter(
      ([input]) => input.action === "call.speak" && input.text === "I'm here.",
    ),
  ).toHaveLength(1);
});

it("moves queued typed words from a closed call and delivers them on the replacement call", async () => {
  const f = fixture({
    callId: "closed-typed",
    closed: true,
    options,
    offsets: {},
    recordings: [],
    typed: [{ id: "kept-words", text: "Keep this", modelSelection: options.modelSelection }],
  });
  await f.session.start(options, []);
  const actions = f.request.mock.calls.map(([input]) => input.action);
  expect(actions.indexOf("call.close")).toBeLessThan(actions.indexOf("call.say"));
  expect(f.request.mock.calls.find(([input]) => input.action === "call.say")?.[0]).toMatchObject({
    callId: f.saved()?.callId,
    retryOf: { callId: "closed-typed", utteranceId: "kept-words" },
    text: "Keep this",
  });
  expect(f.saved()?.callId).not.toBe("closed-typed");
  const sent = f.request.mock.calls.filter(([input]) => input.action === "call.say");
  expect(sent).toHaveLength(1);
  expect(sent[0]![0].utteranceId).not.toBe("kept-words");
  expect(f.saved()?.typed).toEqual([]);
});
