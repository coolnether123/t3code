import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FILLER_DELAY_MS, TurnFiller } from "./filler.ts";
import { fillerClips } from "./fillerClips.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  vi.useFakeTimers();
  const play = vi.fn(async (_audio: string, _rate: number, _signal: AbortSignal) => {});
  const started = vi.fn();
  const signal = new AbortController();
  const filler = new TurnFiller(play);
  return { filler, play, started, signal };
}

afterEach(() => vi.useRealTimers());

describe("speech turn filler playback", () => {
  it("waits one second, plays once, and ignores duplicate sends for that turn", async () => {
    const f = fixture();
    const pending = f.filler.arm("utterance", f.signal.signal);
    await vi.advanceTimersByTimeAsync(FILLER_DELAY_MS - 1);
    expect(f.play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f.play).toHaveBeenCalledTimes(1);
    expect(f.play.mock.calls[0]![1]).toBe(24_000);
    await f.filler.arm("utterance", f.signal.signal);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.play).toHaveBeenCalledTimes(1);
  });

  it("suppresses filler when real audio wins the timer", async () => {
    const f = fixture();
    const pending = f.filler.arm("utterance", f.signal.signal);
    await vi.advanceTimersByTimeAsync(999);
    await f.filler.play("reply", 24_000, f.signal.signal, f.started);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(f.play.mock.calls.map(([audio]) => audio)).toEqual(["reply"]);
    expect(f.started).toHaveBeenCalledTimes(1);
  });

  it("finishes the filler before scheduling arriving reply chunks", async () => {
    const f = fixture();
    const ended = deferred();
    f.play.mockImplementationOnce(async () => ended.promise);
    const pending = f.filler.arm("utterance", f.signal.signal);
    await vi.advanceTimersByTimeAsync(FILLER_DELAY_MS);
    expect(f.filler.isPlaying).toBe(true);
    const first = f.filler.play("first", 24_000, f.signal.signal, f.started);
    const second = f.filler.play("second", 24_000, f.signal.signal, f.started);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.play).toHaveBeenCalledTimes(1);
    expect(f.started).not.toHaveBeenCalled();
    expect(f.play.mock.calls[0]![2].aborted).toBe(false);
    ended.resolve();
    await Promise.all([pending, first, second]);
    expect(f.play.mock.calls.slice(1).map(([audio]) => audio)).toEqual(["first", "second"]);
    expect(f.started).toHaveBeenCalledTimes(2);
    expect(f.filler.isPlaying).toBe(false);
  });

  it("starts no filler without a sent speech turn", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.play).not.toHaveBeenCalled();
    await f.filler.play("status reply", 24_000, f.signal.signal, f.started);
    expect(f.play.mock.calls.map(([audio]) => audio)).toEqual(["status reply"]);
  });

  it.each(["cancel", "abort"])("cancels a pending filler on %s", async (mode) => {
    const f = fixture();
    const pending = f.filler.arm("utterance", f.signal.signal);
    if (mode === "cancel") f.filler.cancel();
    else f.signal.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(f.play).not.toHaveBeenCalled();
  });

  it("varies clips across turns without repeating the last one", async () => {
    const f = fixture();
    for (let turn = 0; turn < 20; turn++) {
      const pending = f.filler.arm(String(turn), f.signal.signal);
      await vi.advanceTimersByTimeAsync(FILLER_DELAY_MS);
      await pending;
    }
    const clips = f.play.mock.calls.map(([audio]) => audio);
    expect(clips).toHaveLength(20);
    for (let i = 1; i < clips.length; i++) expect(clips[i]).not.toBe(clips[i - 1]);
  });

  it("keeps replies playable after optional filler playback fails", async () => {
    const f = fixture();
    f.play.mockRejectedValueOnce(new Error("Optional clip failed"));
    const pending = f.filler.arm("utterance", f.signal.signal);
    await vi.advanceTimersByTimeAsync(FILLER_DELAY_MS);
    await pending;
    await f.filler.play("reply", 24_000, f.signal.signal, f.started);
    expect(f.play.mock.calls.at(-1)?.[0]).toBe("reply");
  });

  it("does not play a reply that was interrupted while it waited for filler", async () => {
    const f = fixture();
    const ended = deferred();
    f.play.mockImplementationOnce(async () => ended.promise);
    const pending = f.filler.arm("utterance", f.signal.signal);
    await vi.advanceTimersByTimeAsync(FILLER_DELAY_MS);
    const reply = f.filler.play("reply", 24_000, f.signal.signal, f.started);
    const rejected = expect(reply).rejects.toThrow();
    f.signal.abort(new Error("Interrupted"));
    ended.resolve();
    await pending;
    await rejected;
    expect(f.play).toHaveBeenCalledTimes(1);
    expect(f.started).not.toHaveBeenCalled();
  });

  it("ships all six playable mono PCM16 clips with their original durations", () => {
    expect(fillerClips).toHaveLength(6);
    for (const clip of fillerClips) {
      const bytes = atob(clip.audio).length;
      expect(clip.sampleRate).toBe(24_000);
      expect(bytes % 2).toBe(0);
      expect(bytes / 2 / clip.sampleRate).toBeGreaterThanOrEqual(0.5);
      expect(bytes / 2 / clip.sampleRate).toBeLessThanOrEqual(3);
    }
  });
});
