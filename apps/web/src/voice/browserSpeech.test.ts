import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@t3tools/client-runtime/voice-call/transport", () => ({
  createVoiceRequestCommand: () => ({ run: vi.fn() }),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
import { createBrowserAudio } from "./browserSpeech";

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
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal("AudioContext", FakeAudio);
  const audio = createBrowserAudio(onInterrupted);
  audio.unlock();
  return audio;
}
const pcm = btoa("\0".repeat(16000));
afterEach(() => {
  contexts.length = 0;
  vi.unstubAllGlobals();
});

describe("streamed browser PCM scheduling", () => {
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
  it("cancels a readiness tone when its audio context is interrupted", async () => {
    const interrupted = vi.fn();
    const audio = fixture(interrupted);
    const ready = audio.ready(new AbortController().signal);
    contexts[0]!.state = "interrupted";
    contexts[0]!.dispatchEvent(new Event("statechange"));
    await expect(ready).rejects.toThrow("Audio was interrupted");
    expect(contexts[0]!.tones[0]!.disconnect).toHaveBeenCalledOnce();
    expect(interrupted).toHaveBeenCalledOnce();
    audio.close();
  });
  it.each(["audio context", "microphone"])(
    "reports an interrupted %s once and reacquires the microphone",
    async (cause) => {
      const interrupted = vi.fn();
      const audio = fixture(interrupted);
      const track = Object.assign(new EventTarget(), { stop: vi.fn() });
      vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      } as unknown as MediaStream);
      const signal = new AbortController().signal;
      await audio.prepare(signal);
      if (cause === "microphone") {
        track.dispatchEvent(new Event("ended"));
      } else {
        contexts[0]!.state = "interrupted";
        contexts[0]!.dispatchEvent(new Event("statechange"));
        contexts[0]!.dispatchEvent(new Event("statechange"));
      }
      expect(interrupted).toHaveBeenCalledOnce();
      audio.unlock();
      await audio.prepare(signal);
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
      expect(track.stop).toHaveBeenCalledOnce();
      audio.close();
      contexts[0]!.dispatchEvent(new Event("statechange"));
      expect(interrupted).toHaveBeenCalledOnce();
    },
  );
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
    for (let index = 0; index < 4; index++) frame(0);
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
    for (let index = 0; index < 4; index++)
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
