import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SpeechRequest, SpeechResponse } from "@t3tools/contracts";
import { ThreadVoiceSession, type VoiceDependencies } from "./session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const recording = deferred<{ audio: string; sampleRate: number }>();
  const transcript = deferred<SpeechResponse>();
  const playback = deferred<void>();
  const submit = vi.fn(() => true);
  const change = vi.fn();
  const request = vi.fn(async (input: SpeechRequest): Promise<SpeechResponse> => {
    if (input.action === "acquire") return { sessionId: "lease-1" };
    if (input.action === "transcribe") return transcript.promise;
    if (input.action === "speak") return { audio: "AAA=", sampleRate: 24000 };
    return {};
  });
  const audio = {
    unlock: vi.fn(),
    close: vi.fn(),
    finish: vi.fn(() => recording.resolve({ audio: "AAA=", sampleRate: 16000 })),
    capture: vi.fn(() => recording.promise),
    play: vi.fn<VoiceDependencies["audio"]["play"]>(() => playback.promise),
  };
  return {
    session: new ThreadVoiceSession({ request, audio, submit, change }),
    request,
    audio,
    submit,
    change,
    recording,
    transcript,
    playback,
  };
}
afterEach(() => vi.useRealTimers());
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("thread voice session", () => {
  it("submits the transcript once through the supplied current-thread send action", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const start = f.session.start([], []);
    await tick();
    f.session.finish();
    await tick();
    f.transcript.resolve({ text: "  Check the build  " });
    await start;
    expect(f.submit).toHaveBeenCalledExactlyOnceWith("Check the build");
    expect(f.change).toHaveBeenLastCalledWith("waiting", undefined);
    f.session.stop();
  });
  it("discards transcription that completes after stop or chat disposal", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const start = f.session.start([], []);
    await tick();
    f.session.finish();
    await tick();
    f.session.stop();
    f.transcript.resolve({ text: "stale" });
    await start;
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.audio.close).toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledWith(
      { action: "release", sessionId: "lease-1" },
      expect.any(AbortSignal),
    );
  });
  it("discards microphone capture that resolves after stop", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const start = f.session.start([], []);
    await tick();
    f.session.stop();
    f.recording.resolve({ audio: "AAA=", sampleRate: 16000 });
    await start;
    expect(f.request.mock.calls.some(([input]) => input.action === "transcribe")).toBe(false);
  });
  it("does not submit an empty transcript", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const start = f.session.start([], []);
    await tick();
    f.session.finish();
    await tick();
    f.transcript.resolve({ text: " " });
    await start;
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.change).toHaveBeenLastCalledWith("ready", undefined);
    f.session.stop();
  });
  it("speaks only new complete text and progress, without replaying history or stream prefixes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const old = { id: "old", role: "assistant", text: "History.", streaming: false };
    const start = f.session.start([old], [{ id: "old-tool", summary: "Old progress" }]);
    await tick();
    f.session.finish();
    await tick();
    f.transcript.resolve({ text: "Go" });
    await start;
    const message = { id: "new", role: "assistant", text: "First. Part", streaming: true };
    f.session.observe([old, message], [], true);
    await tick();
    f.session.observe([old, { ...message, text: "First. Part two.", streaming: false }], [], false);
    f.playback.resolve();
    await tick();
    await tick();
    const spoken = f.request.mock.calls
      .filter(([input]) => input.action === "speak")
      .map(([input]) => input.text);
    expect(spoken).toEqual(["First.", "Part two."]);
    f.session.observe(
      [old, { ...message, text: "First. Part two.", streaming: false }],
      [{ id: "tool", summary: "Build passed" }],
      false,
    );
    await tick();
    expect(f.request.mock.calls.some(([input]) => input.text === "Build passed")).toBe(true);
    f.session.stop();
  });
  it("aborts playback and discards queued speech on interruption", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const start = f.session.start([], []);
    await tick();
    f.session.finish();
    await tick();
    f.transcript.resolve({ text: "Go" });
    await start;
    f.session.observe(
      [{ id: "new", role: "assistant", text: "One. Two.", streaming: false }],
      [],
      true,
    );
    await tick();
    const signal = f.audio.play.mock.calls[0]?.[2];
    f.session.stop();
    expect(signal?.aborted).toBe(true);
    f.playback.resolve();
    await tick();
    expect(f.request.mock.calls.filter(([input]) => input.action === "speak")).toHaveLength(1);
  });
  it("releases a lease whose acquisition finishes after cancellation", async () => {
    const lease = deferred<SpeechResponse>();
    const f = fixture();
    f.request.mockImplementationOnce(() => lease.promise);
    const start = f.session.start([], []);
    f.session.stop();
    lease.resolve({ sessionId: "late" });
    await start;
    expect(f.audio.capture).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledWith(
      { action: "release", sessionId: "late" },
      expect.any(AbortSignal),
    );
  });
});
