import type { SpeechRequest, SpeechResponse } from "@t3tools/contracts";

export type VoiceState =
  | "idle"
  | "starting"
  | "listening"
  | "transcribing"
  | "waiting"
  | "speaking"
  | "ready"
  | "error";
type Message = { id: string; role: string; text: string; streaming: boolean };
type Activity = { id: string; summary: string };
export interface VoiceDependencies {
  request(input: SpeechRequest, signal: AbortSignal): Promise<SpeechResponse>;
  audio: {
    unlock(): void;
    close(): void;
    finish(): void;
    capture(signal: AbortSignal): Promise<{ audio: string; sampleRate: number }>;
    play(audio: string, sampleRate: number, signal: AbortSignal): Promise<void>;
  };
  submit(text: string): boolean;
  change(state: VoiceState, error?: string): void;
}

/** Cancellation invalidates the session before releasing any asynchronous resource. */
export class ThreadVoiceSession {
  private abort = new AbortController();
  private lease: string | undefined;
  private renew: ReturnType<typeof setInterval> | undefined;
  private offsets = new Map<string, number>();
  private activities = new Set<string>();
  private queue: string[] = [];
  private playing = false;
  private active = false;
  private state: VoiceState = "idle";
  constructor(private deps: VoiceDependencies) {}
  private change(state: VoiceState, error?: string) {
    this.state = state;
    this.deps.change(state, error);
  }
  stop() {
    this.active = false;
    this.abort.abort();
    clearInterval(this.renew);
    this.queue = [];
    this.playing = false;
    this.deps.audio.close();
    const lease = this.lease;
    this.lease = undefined;
    if (lease)
      void this.deps
        .request({ action: "release", sessionId: lease }, new AbortController().signal)
        .catch(() => {});
    this.change("idle");
  }
  private fail(error: unknown, signal: AbortSignal) {
    if (signal.aborted) return;
    this.stop();
    this.change("error", error instanceof Error ? error.message : "Voice failed. Try again.");
  }
  async start(messages: readonly Message[], activities: readonly Activity[]) {
    this.stop();
    this.abort = new AbortController();
    this.active = true;
    const signal = this.abort.signal;
    this.offsets = new Map(messages.map((message) => [message.id, message.text.length]));
    this.activities = new Set(activities.map((activity) => activity.id));
    this.change("starting");
    try {
      this.deps.audio.unlock();
      const result = await this.deps.request({ action: "acquire" }, signal);
      if (signal.aborted) {
        if (result.sessionId)
          void this.deps
            .request(
              { action: "release", sessionId: result.sessionId },
              new AbortController().signal,
            )
            .catch(() => {});
        return;
      }
      if (!result.sessionId) throw new Error("Speech service did not create a session.");
      this.lease = result.sessionId;
      this.renew = setInterval(() => {
        void this.deps
          .request({ action: "renew", sessionId: this.lease }, signal)
          .catch((error) => this.fail(error, signal));
      }, 60_000);
      await this.listen();
    } catch (error) {
      this.fail(error, signal);
    }
  }
  async listen() {
    if (!this.active || !this.lease || !["starting", "ready", "waiting"].includes(this.state))
      return;
    const signal = this.abort.signal;
    this.change("listening");
    try {
      const recording = await this.deps.audio.capture(signal);
      if (signal.aborted) return;
      this.change("transcribing");
      const result = await this.deps.request(
        { action: "transcribe", sessionId: this.lease, ...recording },
        signal,
      );
      if (signal.aborted) return;
      if (!result.text?.trim()) {
        this.change("ready");
        return;
      }
      this.change("waiting");
      if (!this.deps.submit(result.text.trim()))
        throw new Error("Chat changed or is busy. Speech was not sent.");
    } catch (error) {
      this.fail(error, signal);
    }
  }
  finish() {
    if (this.state === "listening") this.deps.audio.finish();
  }
  observe(messages: readonly Message[], activities: readonly Activity[], running: boolean) {
    if (!this.active) return;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      let offset = this.offsets.get(message.id) ?? 0;
      while (offset < message.text.length) {
        const remaining = message.text.slice(offset);
        const sentence = remaining.match(/^[\s\S]*?[.!?](?:\s|$)/)?.[0];
        const chunk =
          sentence ??
          (!message.streaming || remaining.length >= 1200 ? remaining.slice(0, 1200) : "");
        if (!chunk) break;
        for (let i = 0; i < chunk.length; i += 1200) this.queue.push(chunk.slice(i, i + 1200));
        offset += chunk.length;
      }
      this.offsets.set(message.id, offset);
    }
    const fresh = activities.filter((activity) => !this.activities.has(activity.id));
    for (const activity of fresh) this.activities.add(activity.id);
    // Coalesce tool bursts. Assistant text always takes priority over activity summaries.
    if (!this.queue.length && fresh.length)
      this.queue.push(fresh[fresh.length - 1]!.summary.slice(0, 1200));
    if (!running && this.state === "waiting" && !this.queue.length) this.change("ready");
    if (!["starting", "listening", "transcribing"].includes(this.state)) void this.speak();
  }
  private async speak() {
    if (this.playing || !this.lease || !this.queue.length) return;
    this.playing = true;
    const signal = this.abort.signal;
    try {
      while (this.queue.length && !signal.aborted) {
        const text = this.queue
          .shift()!
          .replace(/[`#*_]/g, "")
          .trim();
        if (!text) continue;
        this.change("speaking");
        const result = await this.deps.request(
          { action: "speak", sessionId: this.lease, text },
          signal,
        );
        if (signal.aborted) return;
        if (!result.audio || !result.sampleRate)
          throw new Error("Speech service returned no audio.");
        await this.deps.audio.play(result.audio, result.sampleRate, signal);
      }
      if (!signal.aborted) {
        this.playing = false;
        this.change("ready");
      }
    } catch (error) {
      this.fail(error, signal);
    }
  }
}
