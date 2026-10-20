import { describe, expect, it } from "vite-plus/test";
import { shouldEndTurn } from "./turnEnding";

describe("speech turn ending", () => {
  it.each(["Well, um", "uh", "well", "so", "and", "like"])(
    "allows a thinking pause after %s",
    (transcript) => {
      const timeline = { speechMs: 1_500, lastBurstMs: 600, silenceMs: 1_100, transcript };
      expect(shouldEndTurn(timeline)).toBe(false);
      expect(shouldEndTurn({ ...timeline, silenceMs: 1_850 })).toBe(true);
    },
  );
  it("uses audio alone to protect a brief opening or a trailing fragment", () => {
    expect(shouldEndTurn({ speechMs: 600, lastBurstMs: 600, silenceMs: 1_100 })).toBe(false);
    expect(shouldEndTurn({ speechMs: 2_000, lastBurstMs: 250, silenceMs: 1_800 })).toBe(false);
    expect(shouldEndTurn({ speechMs: 2_000, lastBurstMs: 250, silenceMs: 1_850 })).toBe(true);
  });
  it("ends sustained speech and a clearly finished question promptly", () => {
    expect(shouldEndTurn({ speechMs: 1_500, lastBurstMs: 900, silenceMs: 1_050 })).toBe(true);
    expect(
      shouldEndTurn({
        speechMs: 600,
        lastBurstMs: 600,
        silenceMs: 1_050,
        transcript: "What time is it?",
      }),
    ).toBe(true);
  });
  it("does not submit an empty microphone or cut an active speaker for an update", () => {
    expect(shouldEndTurn({ speechMs: 0, lastBurstMs: 0, silenceMs: 20_000 })).toBe(false);
    expect(
      shouldEndTurn({ speechMs: 0, lastBurstMs: 0, silenceMs: 1_050, finishAtPause: true }),
    ).toBe(true);
    expect(
      shouldEndTurn({ speechMs: 1_500, lastBurstMs: 900, silenceMs: 0, finishAtPause: true }),
    ).toBe(false);
  });
});
