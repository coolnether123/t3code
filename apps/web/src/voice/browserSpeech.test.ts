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
  stop = vi.fn(() => this.dispatchEvent(new Event("ended")));
  start(at: number) {
    this.startedAt = at;
  }
  end() {
    this.dispatchEvent(new Event("ended"));
  }
}
const contexts: FakeAudio[] = [];
class FakeAudio {
  currentTime = 0;
  destination = {};
  sources: Source[] = [];
  constructor() {
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
}
function fixture() {
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal("AudioContext", FakeAudio);
  const audio = createBrowserAudio();
  audio.unlock();
  return audio;
}
const pcm = btoa("\0".repeat(16000));
afterEach(() => {
  contexts.length = 0;
  vi.unstubAllGlobals();
});

describe("streamed browser PCM scheduling", () => {
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
