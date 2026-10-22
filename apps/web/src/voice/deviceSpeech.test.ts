import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDeviceSpeech, type DeviceRecognition } from "./deviceSpeech";

const recognitions: FakeRecognition[] = [];
class FakeRecognition implements DeviceRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: DeviceRecognition["onresult"] = null;
  onend: DeviceRecognition["onend"] = null;
  onerror: DeviceRecognition["onerror"] = null;
  onspeechstart: DeviceRecognition["onspeechstart"] = null;
  start = vi.fn();
  abort = vi.fn();
  stop = vi.fn(() => this.onend?.());
  constructor() {
    recognitions.push(this);
  }
  result(text: string, isFinal = true) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] });
  }
}
afterEach(() => {
  recognitions.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture(prefixed = false) {
  vi.useFakeTimers();
  vi.stubGlobal(
    "window",
    prefixed
      ? { webkitSpeechRecognition: FakeRecognition }
      : { SpeechRecognition: FakeRecognition },
  );
  return createDeviceSpeech();
}
describe("device call recognition", () => {
  it("retains recognized words locally when the call closes before the pause timer", async () => {
    const speech = fixture();
    const capture = speech.capture(new AbortController().signal);
    recognitions[0]!.result("Keep these words.");
    speech.close();
    expect(await capture).toBe("Keep these words.");
  });
  it("waits for resumed speech after Safari restarts before sending the previous final", async () => {
    const speech = fixture();
    const delivered = vi.fn();
    const capture = speech.capture(new AbortController().signal).then(delivered);
    recognitions[0]!.result("Check and");
    recognitions[0]!.onend?.();
    await vi.advanceTimersByTimeAsync(250);
    recognitions[1]!.onspeechstart?.();
    await vi.advanceTimersByTimeAsync(2500);
    expect(delivered).not.toHaveBeenCalled();
    recognitions[1]!.result("read the agenda.");
    await vi.advanceTimersByTimeAsync(3500);
    await capture;
    expect(delivered).toHaveBeenCalledExactlyOnceWith("Check and read the agenda.");
  });
  it("includes the final result produced by an explicit Send speech stop", async () => {
    const speech = fixture();
    const capture = speech.capture(new AbortController().signal);
    recognitions[0]!.result("Check my agenda", false);
    recognitions[0]!.stop.mockImplementation(() => {
      recognitions[0]!.result("Check my agenda.");
      recognitions[0]!.onend?.();
    });
    speech.finish();
    expect(await capture).toBe("Check my agenda.");
  });
  it("accepts Safari's prefixed recognizer and emits repeated final results once", async () => {
    const speech = fixture(true);
    const delivered = vi.fn();
    const capture = speech.capture(new AbortController().signal).then(delivered);
    recognitions[0]!.result("Read my agenda.");
    recognitions[0]!.result("Read my agenda.");
    await vi.advanceTimersByTimeAsync(3500);
    await capture;
    expect(delivered).toHaveBeenCalledExactlyOnceWith("Read my agenda.");
    expect(recognitions[0]!.stop).toHaveBeenCalledOnce();
  });
  it.each(["um", "so", "and"])(
    "keeps a short pause after %s inside the utterance",
    async (word) => {
      const speech = fixture();
      const delivered = vi.fn();
      const capture = speech.capture(new AbortController().signal).then(delivered);
      recognitions[0]!.result(`Check ${word}`);
      await vi.advanceTimersByTimeAsync(1050);
      expect(delivered).not.toHaveBeenCalled();
      recognitions[0]!.onend?.();
      await vi.advanceTimersByTimeAsync(250);
      recognitions[1]!.result("the agenda.");
      await vi.advanceTimersByTimeAsync(3500);
      await capture;
      expect(delivered).toHaveBeenCalledExactlyOnceWith(`Check ${word} the agenda.`);
    },
  );
  it("restarts after an automatic end and stops restarting when the call closes", async () => {
    const speech = fixture();
    const capture = speech.capture(new AbortController().signal);
    recognitions[0]!.onend?.();
    await vi.advanceTimersByTimeAsync(250);
    expect(recognitions[1]!.start).toHaveBeenCalledOnce();
    speech.close();
    expect(await capture).toBe("");
    await vi.advanceTimersByTimeAsync(1000);
    expect(recognitions).toHaveLength(2);
    expect(recognitions[1]!.abort).toHaveBeenCalledOnce();
  });
  it("does not send a previous final while an interim result is still arriving", async () => {
    const speech = fixture();
    const delivered = vi.fn();
    const capture = speech.capture(new AbortController().signal).then(delivered);
    recognitions[0]!.result("Check", false);
    recognitions[0]!.result("the agenda", false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(delivered).not.toHaveBeenCalled();
    speech.close();
    await capture;
  });
  it("holds trailing hesitation for over three seconds and commits an interim yield in 200 ms", async () => {
    const speech = fixture();
    const delivered = vi.fn();
    const revisions: unknown[] = [];
    const capture = speech
      .capture(new AbortController().signal, {
        transcript: (value) => {
          revisions.push(value);
        },
      })
      .then(delivered);
    recognitions[0]!.result("Well, um...", false);
    await vi.advanceTimersByTimeAsync(3500);
    expect(delivered).not.toHaveBeenCalled();
    recognitions[0]!.result("You can speak", false);
    await vi.advanceTimersByTimeAsync(199);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await capture;
    expect(delivered).toHaveBeenCalledExactlyOnceWith("You can speak");
    expect(revisions).toEqual([
      { text: "Well, um...", revision: 1, final: false },
      { text: "You can speak", revision: 2, final: false },
    ]);
  });
  it("returns unavailable without a recognition API or after denied permission", async () => {
    vi.stubGlobal("window", {});
    expect(await createDeviceSpeech().capture(new AbortController().signal)).toBeNull();
    const speech = fixture();
    const capture = speech.capture(new AbortController().signal);
    recognitions[0]!.onerror?.({ error: "not-allowed" });
    expect(await capture).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(recognitions).toHaveLength(1);
  });
});
