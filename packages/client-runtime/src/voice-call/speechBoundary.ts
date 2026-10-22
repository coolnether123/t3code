/** Inspect request edges without holding trailing audio. Playback may shorten
 * the unplayed tail at EOS; interior pauses and quiet breaths stay intact.
 */
export class SpeechBoundaryTrimmer {
  private carry = "";
  private quiet = "";
  private started = false;
  private quietSamples = 0;
  private readonly windowBytes: number;
  private readonly paddingBytes: number;
  private readonly trimStart: boolean;

  constructor(sampleRate: number, trimStart: boolean) {
    this.trimStart = trimStart;
    this.windowBytes = Math.max(1, Math.round(sampleRate * 0.005)) * 2;
    this.paddingBytes = Math.round(sampleRate * 0.01) * 2;
  }

  push(audio: string): string {
    const binary = atob(audio);
    if (binary.length % 2) throw new Error("Incomplete PCM16 sample.");
    this.carry += binary;
    let output = "";
    let offset = 0;
    for (; offset + this.windowBytes <= this.carry.length; offset += this.windowBytes)
      output += this.window(this.carry.slice(offset, offset + this.windowBytes));
    this.carry = this.carry.slice(offset);
    return output ? btoa(output) : "";
  }

  finish(trimEnd: boolean): { audio: string; trimSamples: number } {
    let output = this.carry ? this.window(this.carry) : "";
    this.carry = "";
    output += this.quiet;
    this.quiet = "";
    return {
      audio: output ? btoa(output) : "",
      trimSamples:
        trimEnd && this.started ? Math.max(0, this.quietSamples - this.paddingBytes / 2) : 0,
    };
  }

  private window(binary: string): string {
    let energy = 0;
    let peak = 0;
    for (let i = 0; i < binary.length; i += 2) {
      const unsigned = binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8);
      const sample = unsigned >= 32768 ? unsigned - 65536 : unsigned;
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    // -55 dB RMS and -49 dB peak keep quiet consonants and breaths above the gate.
    const quiet = energy <= (binary.length / 2) * 58 ** 2 && peak <= 116;
    if (!quiet) {
      const output = this.quiet + binary;
      this.quiet = "";
      this.started = true;
      this.quietSamples = 0;
      return output;
    }
    this.quietSamples += binary.length / 2;
    if (!this.started && !this.trimStart) return binary;
    if (this.started) return binary;
    this.quiet += binary;
    if (!this.started) this.quiet = this.quiet.slice(-this.paddingBytes);
    return "";
  }
}
