import { describe, expect, it } from "vite-plus/test";
import { SpeechBoundaryTrimmer } from "./speechBoundary.ts";

const rate = 24000;
const pcm = (ms: number, sample: number) => {
  const bytes = new Uint8Array(Math.round((ms / 1000) * rate) * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length; i += 2) view.setInt16(i, sample, true);
  return String.fromCharCode(...bytes);
};

const run = (binary: string, trimStart: boolean, trimEnd: boolean, bytes = 3840) => {
  const trimmer = new SpeechBoundaryTrimmer(rate, trimStart);
  let output = "";
  for (let i = 0; i < binary.length; i += bytes)
    output += atob(trimmer.push(btoa(binary.slice(i, i + bytes))));
  const end = trimmer.finish(trimEnd);
  output += atob(end.audio);
  return end.trimSamples ? output.slice(0, -end.trimSamples * 2) : output;
};

describe("speech request edges", () => {
  it("keeps the response onset, final cadence and interior pauses byte for byte", () => {
    const audio = pcm(40, 0) + pcm(80, 700) + pcm(120, 0) + pcm(80, 700) + pcm(100, 0);
    expect(run(audio, false, false, 106)).toBe(audio);
  });

  it("keeps ten milliseconds on each internal edge and preserves interior silence", () => {
    const audio = pcm(70, 0) + pcm(80, 700) + pcm(120, 0) + pcm(80, 700) + pcm(100, 0);
    expect(run(audio, true, true, 106)).toBe(
      pcm(10, 0) + pcm(80, 700) + pcm(120, 0) + pcm(80, 700) + pcm(10, 0),
    );
  });

  it("preserves quiet breaths and short consonant transients", () => {
    const audio = pcm(80, 700) + pcm(80, 90) + pcm(5, 150) + pcm(100, 0);
    expect(run(audio, false, true, 106)).toBe(audio.slice(0, -pcm(90, 0).length));
  });

  it("emits active audio before the request ends without a playback lead", () => {
    const trimmer = new SpeechBoundaryTrimmer(rate, false);
    const audio = pcm(80, 700);
    expect(atob(trimmer.push(btoa(audio)))).toBe(audio);
    expect(trimmer.finish(true)).toEqual({ audio: "", trimSamples: 0 });
  });

  it("streams quiet interior audio immediately and only reports the tail at EOS", () => {
    const trimmer = new SpeechBoundaryTrimmer(rate, false);
    const speech = pcm(80, 700);
    const quiet = pcm(120, 0);
    expect(atob(trimmer.push(btoa(speech)))).toBe(speech);
    expect(atob(trimmer.push(btoa(quiet)))).toBe(quiet);
    expect(trimmer.finish(true)).toEqual({ audio: "", trimSamples: rate * 0.11 });
  });

  it("preserves the final partial analysis window", () => {
    const audio = pcm(82, 700);
    expect(run(audio, false, false, 106)).toBe(audio);
  });

  it("rejects half samples", () => {
    expect(() => new SpeechBoundaryTrimmer(rate, false).push(btoa("a"))).toThrow("PCM16");
  });
});
