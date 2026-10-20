import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

export const FILLER_DELAY_MS = 1_000;

type Clip = { id: string; audio: string; sampleRate: number };
type Play = (audio: string, sampleRate: number, signal: AbortSignal) => Promise<void>;

/** Shares the PCM playback boundary with replies, without counting filler as reply audio. */
export class TurnFiller {
  private timer = new AbortController();
  private turn: string | undefined;
  private lastClip: string | undefined;
  private realAudio = false;
  private playback: Promise<void> | undefined;
  private clips: Promise<readonly Clip[]> | undefined;
  private playAudio: Play;

  constructor(play: Play) {
    this.playAudio = play;
  }

  prepare() {
    // Load only for calls. A missing optional clip never prevents real speech.
    return (this.clips ??= import("./fillerClips.ts")
      .then((module) => module.fillerClips)
      .catch(() => []));
  }

  get isPlaying() {
    return this.playback !== undefined;
  }

  async arm(turn: string, signal: AbortSignal, elapsedMs = 0) {
    if (this.turn === turn) return;
    this.cancel();
    this.turn = turn;
    this.realAudio = false;
    const timer = new AbortController();
    this.timer = timer;
    const pending = AbortSignal.any([signal, timer.signal]);
    try {
      await Effect.runPromise(Effect.sleep(Math.max(0, FILLER_DELAY_MS - elapsedMs)), {
        signal: pending,
      });
      const clips = (await this.prepare()).filter((clip) => clip.id !== this.lastClip);
      if (pending.aborted || this.realAudio || this.playback || !clips.length) return;
      const clip = clips[Effect.runSync(Random.nextIntBetween(0, clips.length - 1))]!;
      this.lastClip = clip.id;
      // Only the call's playback signal can stop a started clip. Reply arrival cancels
      // the timer, then waits for this clip's final audio frame.
      const playback = this.playAudio(clip.audio, clip.sampleRate, signal);
      this.playback = playback;
      try {
        await playback;
      } finally {
        if (this.playback === playback) this.playback = undefined;
      }
    } catch {
      // Filler is optional. Missing assets or playback failure must not block replies.
    }
  }

  cancel() {
    this.timer.abort();
  }

  async play(audio: string, sampleRate: number, signal: AbortSignal, started: () => void) {
    this.realAudio = true;
    this.cancel();
    await this.playback?.catch(() => {});
    signal.throwIfAborted();
    started();
    await this.playAudio(audio, sampleRate, signal);
  }
}
