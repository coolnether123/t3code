export type PlaybackProgress = {
  generation: string;
  speechId: string;
  channel: "reply" | "backchannel";
  sampleRate: number;
  playedSamples: number;
  queuedSamples: number;
  stopped: boolean;
};

export type PlaybackMetadata = {
  generation: string;
  speechId: string;
  attemptId?: string;
  channel?: "reply" | "backchannel";
  onProgress?: (progress: PlaybackProgress) => void;
};

export type SpeechPlaybackAudio = {
  beginPlayback(generation: string): void;
  stopPlayback(generation: string): PlaybackProgress[];
  playbackProgress(generation: string): PlaybackProgress[];
  trimPlaybackTail(generation: string, speechId: string, samples: number): number;
  emittingSpeech(generation: string): EmittingSpeech[];
  cancelShortClips(generation: string): void;
  play(
    audio: string,
    sampleRate: number,
    signal: AbortSignal,
    metadata?: PlaybackMetadata,
  ): Promise<void>;
  playShortClip(
    audio: string,
    sampleRate: number,
    signal: AbortSignal,
    metadata: PlaybackMetadata,
  ): Promise<void>;
};

export type EmittingSpeech = {
  speechId: string;
  channel: "reply" | "backchannel";
  startedAt: number;
  endsAt: number;
};

type Speech = {
  progress: PlaybackProgress;
  onProgress: PlaybackMetadata["onProgress"];
  attemptId: string | undefined;
};
type Scheduled = {
  speech: Speech;
  source: AudioBufferSourceNode;
  start: number;
  samples: number;
  finish: (stopped: boolean, error?: unknown) => void;
};
type AudioClock = Pick<
  AudioContext,
  "currentTime" | "destination" | "createBuffer" | "createBufferSource"
>;

/** One PCM output owner. Generations are unique response IDs and cannot be reopened.
 * stop returns sample offsets synchronously; completion callbacks use the same offsets.
 * Backchannels mix on their own timeline and can be cancelled independently.
 */
export class SpeechPlaybackController {
  private generation: string | undefined;
  private closed = new Set<string>();
  private speech = new Map<string, Speech>();
  private sources = new Set<Scheduled>();
  private until = { reply: 0, backchannel: 0 };
  private readonly context: AudioClock;
  private readonly leadSeconds: number;

  constructor(context: AudioClock, leadSeconds = 0.02) {
    this.context = context;
    this.leadSeconds = leadSeconds;
  }

  begin(generation: string) {
    if (this.closed.has(generation)) throw new DOMException("Obsolete response", "AbortError");
    if (this.generation === generation) return;
    if (this.generation) this.stop(this.generation);
    this.speech.clear();
    this.generation = generation;
  }

  progress(generation: string): PlaybackProgress[] {
    if (generation !== this.generation) return [];
    return [...this.speech.values()].map((speech) => ({
      ...speech.progress,
      playedSamples:
        speech.progress.playedSamples +
        [...this.sources]
          .filter((entry) => entry.speech === speech)
          .reduce((sum, entry) => sum + this.played(entry), 0),
    }));
  }

  emitting(generation: string): EmittingSpeech[] {
    if (generation !== this.generation) return [];
    const now = this.context.currentTime;
    return [...this.sources]
      .filter(
        (entry) =>
          entry.start <= now &&
          entry.start + entry.samples / entry.speech.progress.sampleRate > now,
      )
      .map((entry) => ({
        speechId: entry.speech.progress.speechId,
        channel: entry.speech.progress.channel,
        startedAt: entry.start,
        endsAt: entry.start + entry.samples / entry.speech.progress.sampleRate,
      }));
  }

  stop(generation: string) {
    if (generation !== this.generation) return [];
    this.closed.add(generation);
    for (const speech of this.speech.values()) speech.progress.stopped = true;
    for (const entry of [...this.sources]) entry.finish(true);
    this.until = { reply: 0, backchannel: 0 };
    return this.progress(generation);
  }

  cancelShortClips(generation: string) {
    if (generation !== this.generation) return;
    this.until.backchannel = 0;
    for (const speech of this.speech.values())
      if (speech.progress.channel === "backchannel") speech.progress.stopped = true;
    for (const entry of [...this.sources])
      if (entry.speech.progress.channel === "backchannel") entry.finish(true);
  }

  private played(entry: Scheduled) {
    return Math.min(
      entry.samples,
      Math.max(
        0,
        Math.floor(
          (this.context.currentTime - entry.start) * entry.speech.progress.sampleRate + 1e-6,
        ),
      ),
    );
  }

  trimTail(generation: string, speechId: string, samples: number): number {
    if (!Number.isSafeInteger(samples) || samples < 0) throw new Error("Invalid tail length.");
    if (generation !== this.generation || this.closed.has(generation)) return 0;
    const speech = this.speech.get(speechId);
    if (!speech || speech.progress.stopped) return 0;
    const entries = [...this.sources]
      .filter((entry) => entry.speech.progress.channel === speech.progress.channel)
      .sort((a, b) => b.start - a.start);
    // A following utterance already scheduled on this timeline must not move.
    if (entries[0]?.speech !== speech) return 0;
    let remaining = samples;
    for (const entry of entries) {
      if (entry.speech !== speech || !remaining) break;
      const removed = Math.min(remaining, entry.samples - this.played(entry));
      entry.samples -= removed;
      remaining -= removed;
      speech.progress.queuedSamples -= removed;
      if (!removed) break;
      if (!entry.samples) {
        entry.finish(false);
        entry.source.stop();
      } else {
        entry.source.stop(entry.start + entry.samples / speech.progress.sampleRate);
      }
    }
    this.until[speech.progress.channel] = Math.max(
      this.context.currentTime,
      ...[...this.sources]
        .filter((entry) => entry.speech.progress.channel === speech.progress.channel)
        .map((entry) => entry.start + entry.samples / entry.speech.progress.sampleRate),
    );
    return samples - remaining;
  }

  play(
    audio: string,
    sampleRate: number,
    signal: AbortSignal,
    metadata: PlaybackMetadata,
  ): Promise<PlaybackProgress> {
    signal.throwIfAborted();
    const { generation, speechId, onProgress } = metadata;
    const channel = metadata.channel ?? "reply";
    if (generation !== this.generation || this.closed.has(generation))
      throw new DOMException("Obsolete response", "AbortError");
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000)
      throw new Error("Invalid PCM sample rate.");
    const binary = atob(audio);
    if (!binary.length || binary.length % 2) throw new Error("Incomplete PCM16 audio.");
    let speech = this.speech.get(speechId);
    if (!speech) {
      speech = {
        progress: {
          generation,
          speechId,
          channel,
          sampleRate,
          playedSamples: 0,
          queuedSamples: 0,
          stopped: false,
        },
        onProgress,
        attemptId: metadata.attemptId,
      };
      this.speech.set(speechId, speech);
    }
    if (speech.progress.stopped) {
      if (!metadata.attemptId || metadata.attemptId === speech.attemptId)
        throw new DOMException("Cancelled speech", "AbortError");
      speech.attemptId = metadata.attemptId;
      speech.progress.stopped = false;
    }
    if (speech.progress.sampleRate !== sampleRate || speech.progress.channel !== channel)
      throw new Error("Speech format changed during playback.");
    speech.onProgress = onProgress ?? speech.onProgress;
    const current = speech;
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const buffer = this.context.createBuffer(1, bytes.length / 2, sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const start =
      this.until[channel] > this.context.currentTime
        ? this.until[channel]
        : this.context.currentTime + this.leadSeconds;
    this.until[channel] = start + buffer.duration;
    current.progress.queuedSamples += samples.length;
    return new Promise((resolve, reject) => {
      let finished = false;
      let started = false;
      const abort = () => {
        // Only this clip's sources are cancelled. A filler signal must not flush a reply.
        current.progress.stopped = true;
        for (const entry of [...this.sources]) if (entry.speech === current) entry.finish(true);
        this.until[channel] = Math.max(
          this.context.currentTime,
          ...[...this.sources]
            .filter((entry) => entry.speech.progress.channel === channel)
            .map((entry) => entry.start + entry.samples / entry.speech.progress.sampleRate),
        );
      };
      const entry: Scheduled = {
        speech: current,
        source,
        start,
        samples: samples.length,
        finish: (stopped, error) => {
          if (finished) return;
          finished = true;
          current.progress.playedSamples += stopped ? this.played(entry) : entry.samples;
          current.progress.stopped ||= stopped;
          this.sources.delete(entry);
          signal.removeEventListener("abort", abort);
          source.removeEventListener("ended", ended);
          if (stopped && started) source.stop();
          source.disconnect();
          const progress = { ...current.progress };
          try {
            if (this.generation === generation && !this.closed.has(generation))
              current.onProgress?.(progress);
            if (error !== undefined) reject(error);
            else resolve(progress);
          } catch (error) {
            reject(error);
          }
        },
      };
      const ended = () => entry.finish(false);
      this.sources.add(entry);
      source.addEventListener("ended", ended, { once: true });
      signal.addEventListener("abort", abort, { once: true });
      try {
        source.start(start);
        started = true;
      } catch (error) {
        entry.finish(true, error);
      }
    });
  }
}
