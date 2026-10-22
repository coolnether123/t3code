import { describe, expect, it, vi } from "vite-plus/test";
import { SpeechPlaybackController } from "./playback.ts";

class Source extends EventTarget {
  buffer: AudioBuffer | null = null;
  startedAt = 0;
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

function fixture() {
  const sources: Source[] = [];
  const context = {
    currentTime: 0,
    destination: {} as AudioDestinationNode,
    createBuffer: (_channels: number, length: number, rate: number) =>
      ({
        duration: length / rate,
        getChannelData: () => new Float32Array(length),
      }) as unknown as AudioBuffer,
    createBufferSource: () => {
      const source = new Source();
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    },
  };
  const controller = new SpeechPlaybackController(context);
  controller.begin("response-1");
  const signal = new AbortController();
  const onProgress = vi.fn();
  const metadata = { generation: "response-1", speechId: "speech-1", onProgress };
  const pcm = btoa("\0".repeat(16000));
  return { controller, context, sources, signal, onProgress, metadata, pcm };
}

describe("speech playback output", () => {
  it("shortens an unplayed tail and schedules the next utterance at its new end", async () => {
    const f = fixture();
    const a = f.controller.play(f.pcm, 8000, f.signal.signal, f.metadata);
    const b = f.controller.play(f.pcm, 8000, f.signal.signal, f.metadata);
    f.context.currentTime = 0.52;
    expect(f.controller.trimTail("response-1", "speech-1", 2400)).toBe(2400);
    expect(f.sources[1]!.stop).toHaveBeenCalledWith(1.72);
    const c = f.controller.play(f.pcm, 8000, f.signal.signal, {
      ...f.metadata,
      speechId: "speech-2",
    });
    expect(f.sources[2]!.startedAt).toBe(1.72);
    f.context.currentTime = 3;
    f.sources.forEach((source) => source.end());
    await Promise.all([a, b, c]);
    expect(f.controller.progress("response-1")[0]).toMatchObject({
      queuedSamples: 13600,
      playedSamples: 13600,
      stopped: false,
    });
  });

  it("never removes heard samples or moves an already scheduled following utterance", async () => {
    const f = fixture();
    const a = f.controller.play(f.pcm, 8000, f.signal.signal, f.metadata);
    f.context.currentTime = 0.52;
    expect(f.controller.trimTail("old", "speech-1", 8000)).toBe(0);
    expect(f.controller.trimTail("response-1", "speech-1", 8000)).toBe(4000);
    expect(f.controller.progress("response-1")[0]).toMatchObject({
      queuedSamples: 4000,
      playedSamples: 4000,
      stopped: false,
    });
    const b = f.controller.play(f.pcm, 8000, f.signal.signal, {
      ...f.metadata,
      speechId: "speech-2",
    });
    expect(f.controller.trimTail("response-1", "speech-1", 1)).toBe(0);
    f.context.currentTime = 2;
    f.sources.forEach((source) => source.end());
    await Promise.all([a, b]);
  });
  it("queues PCM continuously with only a 20 ms initial lead", async () => {
    const f = fixture();
    const a = f.controller.play(f.pcm, 8000, f.signal.signal, f.metadata);
    f.context.currentTime = 0.08;
    const b = f.controller.play(f.pcm, 8000, f.signal.signal, f.metadata);
    expect(f.sources.map((source) => source.startedAt)).toEqual([0.02, 1.02]);
    f.context.currentTime = 2.02;
    f.sources.forEach((source) => source.end());
    await Promise.all([a, b]);
    expect(f.controller.progress("response-1")[0]).toMatchObject({
      playedSamples: 16000,
      queuedSamples: 16000,
      stopped: false,
    });
  });

  it("stops active and scheduled sources synchronously and reports only heard samples", async () => {
    const f = fixture();
    const a = f.controller.play(f.pcm, 8000, f.signal.signal, f.metadata);
    const b = f.controller.play(f.pcm, 8000, f.signal.signal, f.metadata);
    f.context.currentTime = 0.52;
    expect(f.controller.stop("response-1")[0]).toMatchObject({
      playedSamples: 4000,
      queuedSamples: 16000,
      stopped: true,
    });
    expect(f.sources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);
    expect(f.sources.every((source) => source.disconnect.mock.calls.length === 1)).toBe(true);
    expect(f.onProgress).not.toHaveBeenCalled();
    await Promise.all([a, b]);
    expect(() => f.controller.play(f.pcm, 8000, f.signal.signal, f.metadata)).toThrow(
      "Obsolete response",
    );
    expect(() => f.controller.begin("response-1")).toThrow("Obsolete response");
    const count = f.onProgress.mock.calls.length;
    f.sources.forEach((source) => source.end());
    expect(f.onProgress).toHaveBeenCalledTimes(count);
  });

  it("does not let a stale stop cancel a newer response", async () => {
    const f = fixture();
    f.controller.begin("response-2");
    const metadata = { ...f.metadata, generation: "response-2" };
    const audio = f.controller.play(f.pcm, 8000, f.signal.signal, metadata);
    expect(f.controller.stop("response-1")).toEqual([]);
    expect(f.sources[0]!.stop).not.toHaveBeenCalled();
    f.sources[0]!.end();
    await audio;
  });

  it("mixes short clips without delaying a reply and cancels them independently", async () => {
    const f = fixture();
    const shortSignal = new AbortController();
    const short = f.controller.play(f.pcm, 8000, shortSignal.signal, {
      ...f.metadata,
      speechId: "short",
      channel: "backchannel",
    });
    const reply = f.controller.play(f.pcm, 8000, f.signal.signal, f.metadata);
    expect(f.sources.map((source) => source.startedAt)).toEqual([0.02, 0.02]);
    f.context.currentTime = 0.12;
    f.controller.cancelShortClips("response-1");
    expect(f.sources[0]!.stop).toHaveBeenCalledOnce();
    expect(f.sources[1]!.stop).not.toHaveBeenCalled();
    f.sources[1]!.end();
    await Promise.all([short, reply]);
  });

  it("does not count initial lead or underrun silence as heard audio", async () => {
    const f = fixture();
    const first = f.controller.play(f.pcm, 8000, f.signal.signal, f.metadata);
    expect(f.controller.progress("response-1")[0]!.playedSamples).toBe(0);
    f.context.currentTime = 1.5;
    f.sources[0]!.end();
    await first;
    const second = f.controller.play(f.pcm, 8000, f.signal.signal, f.metadata);
    expect(f.sources[1]!.startedAt).toBe(1.52);
    expect(f.controller.stop("response-1")[0]!.playedSamples).toBe(8000);
    await second;
  });

  it("keeps another speech queued when one clip signal is aborted", async () => {
    const f = fixture();
    const a = f.controller.play(f.pcm, 8000, f.signal.signal, f.metadata);
    const b = f.controller.play(f.pcm, 8000, new AbortController().signal, {
      ...f.metadata,
      speechId: "speech-2",
    });
    f.signal.abort();
    expect(f.sources[0]!.stop).toHaveBeenCalledOnce();
    expect(f.sources[1]!.stop).not.toHaveBeenCalled();
    f.sources[1]!.end();
    await Promise.all([a, b]);
  });

  it("retains partial heard audio when a fresh synthesis attempt retries the speech", async () => {
    const f = fixture();
    const first = f.controller.play(f.pcm, 8000, f.signal.signal, {
      ...f.metadata,
      attemptId: "attempt-1",
    });
    f.context.currentTime = 0.52;
    f.signal.abort();
    await first;
    const retry = f.controller.play(f.pcm, 8000, new AbortController().signal, {
      ...f.metadata,
      attemptId: "attempt-2",
    });
    f.context.currentTime = 1.54;
    f.sources[1]!.end();
    await retry;
    expect(f.controller.progress("response-1")[0]!.playedSamples).toBe(12000);
  });
});
