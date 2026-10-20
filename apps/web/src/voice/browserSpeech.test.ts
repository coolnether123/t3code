import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@t3tools/client-runtime/voice-call/transport", () => ({
  createVoiceRequestCommand: () => ({ run: vi.fn() }),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
import { createBrowserAudio } from "./browserSpeech";
import { ThreadVoiceSession } from "./session";
import { ProviderInstanceId } from "@t3tools/contracts";

class Source extends EventTarget {
  buffer: { duration: number } | undefined;
  startedAt = -1;
  connect = vi.fn();
  disconnect = vi.fn();
  stop = vi.fn((at?: number) => {
    if (at === undefined) this.dispatchEvent(new Event("ended"));
  });
  start(at: number) {
    this.startedAt = at;
  }
  end() {
    this.dispatchEvent(new Event("ended"));
  }
}
const contexts: FakeAudio[] = [];
class FakeAudio extends EventTarget {
  state = "running";
  sampleRate = 16000;
  processor = {
    onaudioprocess: null as
      | ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void)
      | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  currentTime = 0;
  destination = {};
  sources: Source[] = [];
  tones: Array<Source & { frequency: { value: number } }> = [];
  constructor() {
    super();
    contexts.push(this);
  }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const source = new Source();
    this.sources.push(source);
    return source;
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createScriptProcessor() {
    return this.processor;
  }
  createGain() {
    return {
      gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }
  createOscillator() {
    const tone = Object.assign(new Source(), { frequency: { value: 0 } });
    this.tones.push(tone);
    return tone;
  }
}
function fixture(onInterrupted?: () => void) {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { isSecureContext: true }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal("AudioContext", FakeAudio);
  const audio = createBrowserAudio(onInterrupted);
  audio.unlock();
  return audio;
}
const pcm = btoa("\0".repeat(16000));
afterEach(() => {
  contexts.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("streamed browser PCM scheduling", () => {
  it("keeps the call listening after a brief interruption and restores listening on Retry after a lasting one", async () => {
    vi.useFakeTimers();
    const audio = fixture(() => session.audioInterrupted());
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async () => {
      const track = Object.assign(new EventTarget(), { stop: vi.fn() });
      return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    });
    vi.spyOn(audio, "ready").mockResolvedValue();
    const change = vi.fn();
    let id = 0;
    const session = new ThreadVoiceSession({
      audio,
      change,
      id: () => `synthetic-${++id}`,
      persistence: {
        read: async () => undefined,
        write: async () => {},
        clear: async () => {},
      },
      request: async (input, signal) => {
        if (input.action === "call.watch")
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        return {};
      },
    });
    try {
      await session.start(
        {
          threadId: "synthetic",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "synthetic",
          },
        },
        [],
      );
      const context = contexts[0]!;
      context.state = "interrupted";
      context.dispatchEvent(new Event("statechange"));
      context.resume.mockImplementation(async () => {
        context.state = "running";
        context.dispatchEvent(new Event("statechange"));
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(change.mock.calls.at(-1)?.[0]).toBe("listening");
      expect(change.mock.calls.some(([state]) => state === "error")).toBe(false);
      context.resume.mockImplementation(async () => {});
      context.state = "interrupted";
      context.dispatchEvent(new Event("statechange"));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(change).toHaveBeenLastCalledWith(
        "error",
        "Audio paused by the phone. Stop other audio, then tap Retry.",
        undefined,
      );
      await session.resume();
      expect(contexts).toHaveLength(2);
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
      expect(change.mock.calls.at(-1)?.[0]).toBe("listening");
    } finally {
      await session.stop();
    }
  });
  it("retains the final speech buffer when hang-up stops audio and cancels network work", async () => {
    const audio = fixture();
    const stop = vi.fn();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
      getTracks: () => [{ stop }],
      getAudioTracks: () => [],
    } as unknown as MediaStream);
    const controller = new AbortController();
    await audio.prepare(controller.signal);
    const captured = audio.capture(controller.signal);
    contexts[0]!.processor.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) },
    });
    audio.finish();
    audio.close();
    controller.abort();
    expect(stop).toHaveBeenCalled();
    expect((await captured).audio).not.toBe("");
  });
  it("cancels a readiness tone only after the recovery window expires", async () => {
    vi.useFakeTimers();
    const interrupted = vi.fn();
    const audio = fixture(interrupted);
    const ready = audio.ready(new AbortController().signal);
    const rejected = expect(ready).rejects.toThrow("Audio was interrupted");
    contexts[0]!.state = "interrupted";
    contexts[0]!.dispatchEvent(new Event("statechange"));
    expect(interrupted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(contexts[0]!.tones[0]!.disconnect).toHaveBeenCalledOnce();
    expect(interrupted).toHaveBeenCalledOnce();
    audio.close();
  });
  it.each(["interrupted", "suspended"])(
    "keeps captured speech and queued playback through a brief %s state",
    async (state) => {
      vi.useFakeTimers();
      const interrupted = vi.fn();
      const audio = fixture(interrupted);
      const track = Object.assign(new EventTarget(), { stop: vi.fn() });
      vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      } as unknown as MediaStream);
      const signal = new AbortController().signal;
      await audio.prepare(signal);
      const captured = audio.capture(signal);
      const playing = audio.play(pcm, 8000, signal);
      const context = contexts[0]!;
      const frame = () =>
        context.processor.onaudioprocess!({
          inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) },
        });
      frame();
      context.state = state;
      context.dispatchEvent(new Event("statechange"));
      frame();
      context.resume.mockImplementation(async () => {
        context.state = "running";
        context.dispatchEvent(new Event("statechange"));
      });
      await vi.advanceTimersByTimeAsync(500);
      frame();
      audio.finish();
      expect(atob((await captured).audio)).toHaveLength(4096 * 2 * 2);
      expect(context.sources).toHaveLength(1);
      expect(context.sources[0]!.stop).not.toHaveBeenCalled();
      context.sources[0]!.end();
      await playing;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(interrupted).not.toHaveBeenCalled();
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
      audio.close();
    },
  );
  it.each(["visibilitychange", "pageshow"])("retries audio on %s", async (event) => {
    vi.useFakeTimers();
    const interrupted = vi.fn();
    const audio = fixture(interrupted);
    const context = contexts[0]!;
    context.state = "interrupted";
    context.dispatchEvent(new Event("statechange"));
    context.resume.mockImplementation(async () => {
      context.state = "running";
    });
    (event === "pageshow" ? window : document).dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(context.state).toBe("running");
    expect(interrupted).not.toHaveBeenCalled();
    audio.close();
  });
  it("recreates the audio context and microphone on Retry after a lasting interruption", async () => {
    vi.useFakeTimers();
    const interrupted = vi.fn();
    const audio = fixture(interrupted);
    const track = Object.assign(new EventTarget(), { stop: vi.fn() });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
    const signal = new AbortController().signal;
    await audio.prepare(signal);
    contexts[0]!.resume.mockRejectedValue(new Error("Phone audio busy"));
    contexts[0]!.state = "interrupted";
    contexts[0]!.dispatchEvent(new Event("statechange"));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(interrupted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(interrupted).toHaveBeenCalledOnce();
    audio.unlock();
    await audio.prepare(signal);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    audio.close();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(interrupted).toHaveBeenCalledOnce();
  });
  it("reconnects a replaced microphone without losing or finishing captured speech", async () => {
    const interrupted = vi.fn();
    const audio = fixture(interrupted);
    const track = Object.assign(new EventTarget(), { stop: vi.fn() });
    const replacement = Object.assign(new EventTarget(), { stop: vi.fn() });
    const stream = (item: typeof track) =>
      ({
        getTracks: () => [item],
        getAudioTracks: () => [item],
      }) as unknown as MediaStream;
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(stream(track))
      .mockResolvedValueOnce(stream(replacement));
    const signal = new AbortController().signal;
    await audio.prepare(signal);
    const captured = audio.capture(signal);
    const frame = () =>
      contexts[0]!.processor.onaudioprocess!({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) },
      });
    frame();
    track.dispatchEvent(new Event("ended"));
    await Promise.resolve();
    frame();
    expect(interrupted).not.toHaveBeenCalled();
    audio.finish();
    expect(atob((await captured).audio)).toHaveLength(4096 * 2 * 2);
    replacement.dispatchEvent(new Event("ended"));
    expect(interrupted).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    audio.close();
  });
  it("holds pending speech through microphone activity and ends capture at a pause", async () => {
    const audio = fixture();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
      getAudioTracks: () => [],
    } as unknown as MediaStream);
    const signal = new AbortController().signal;
    await audio.prepare(signal);
    const captured = audio.capture(signal);
    const processor = contexts[0]!.processor;
    const frame = (value: number) =>
      processor.onaudioprocess!({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(value) },
      });
    frame(0.1);
    audio.finishAtPause();
    frame(0.1);
    expect(processor.onaudioprocess).not.toBeNull();
    for (let index = 0; index < 8; index++) frame(0);
    expect((await captured).audio.length).toBeGreaterThan(0);
    expect(processor.onaudioprocess).toBeNull();
    audio.close();
  });
  it("releases an idle microphone for an update without sending silence as a new utterance", async () => {
    const audio = fixture();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
      getAudioTracks: () => [],
    } as unknown as MediaStream);
    const signal = new AbortController().signal;
    await audio.prepare(signal);
    const captured = audio.capture(signal);
    audio.finishAtPause();
    for (let index = 0; index < 5; index++)
      contexts[0]!.processor.onaudioprocess!({
        inputBuffer: { getChannelData: () => new Float32Array(4096) },
      });
    expect((await captured).audio).toBe("");
    audio.close();
  });
  it("orders chunks on the audio clock and cancels every queued chunk on interrupt", async () => {
    const audio = fixture();
    const signal = new AbortController();
    const first = audio.play(pcm, 8000, signal.signal);
    const second = audio.play(pcm, 8000, signal.signal);
    const sources = contexts[0]!.sources;
    expect(sources[0]!.startedAt).toBeCloseTo(0.02);
    expect(sources[1]!.startedAt).toBeCloseTo(1.02);
    signal.abort();
    await Promise.allSettled([first, second]);
    expect(sources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);
    const next = audio.play(pcm, 8000, new AbortController().signal);
    expect(sources[2]!.startedAt).toBeCloseTo(0.02);
    sources[2]!.end();
    await next;
    audio.close();
  });
  it("starts a later call on the new audio clock without the old queue delay", async () => {
    const audio = fixture();
    const first = audio.play(pcm, 8000, new AbortController().signal);
    contexts[0]!.sources[0]!.end();
    await first;
    audio.close();
    audio.unlock();
    const next = audio.play(pcm, 8000, new AbortController().signal);
    expect(contexts[1]!.sources[0]!.startedAt).toBeCloseTo(0.02);
    contexts[1]!.sources[0]!.end();
    await next;
    audio.close();
  });
});
