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
      expect.stringContaining("Audio was interrupted"),
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
      "error",
      expect.stringContaining("Retry saved speech"),
      undefined,
    );
    failClose = false;
    await f.session.resume();
    expect(f.saved()).toBeUndefined();
    expect(f.change).toHaveBeenLastCalledWith("idle", undefined, undefined);
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
    expect(f.change).toHaveBeenLastCalledWith("idle", undefined, undefined);
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
    expect(f.change).toHaveBeenLastCalledWith("idle", undefined, undefined);
    expect(f.request.mock.calls.map(([input]) => input.action)).toEqual([
      "call.open",
      "call.close",
    ]);
  });
  it("plays one filler a second after Send speech while transcription is still pending", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start(options, []);
    f.session.finish();
    f.session.finish();
    await vi.advanceTimersByTimeAsync(999);
    const before = f.audio.play.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    const after = f.audio.play.mock.calls.length;
    f.transcript.resolve({});
    await f.waiting.promise;
    expect(before).toBe(0);
    expect(after).toBe(1);
    expect(f.audio.play).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.some(([input]) => input.action === "call.speak")).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.audio.play).toHaveBeenCalledTimes(1);
  });

  it("also arms filler after automatic speech submission", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start(options, []);
    f.recording.resolve({ audio: "AAA=", sampleRate: 16_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    f.transcript.resolve({});
    await f.waiting.promise;
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
    f.request.mockImplementation(async (input, signal, onAudio) => {
      if (input.action === "call.speak") synthesis.resolve();
      return original(input, signal, onAudio);
    });
    await f.session.start(options, []);
    f.transcript.resolve({});
    f.session.finish();
    await f.waiting.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    f.session.observe(
      [{ id: "reply", role: "assistant", text: "Checking your task.", streaming: false }],
      true,
      "voice-turn",
    );
    await synthesis.promise;
    expect(f.audio.play).toHaveBeenCalledTimes(1);
    expect(f.audio.play.mock.calls[0]![2].aborted).toBe(false);
    finishFiller.resolve();
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
