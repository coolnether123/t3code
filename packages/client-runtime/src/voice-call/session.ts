import type { CallOptions, CallRequest, CallStatus, SpeechResponse } from "@t3tools/contracts";

export type VoiceState = "idle" | "preparing" | "listening" | "saving" | "transcribing" | "waiting" | "speaking" | "ready" | "reconnecting" | "error";
type Message = { id: string; role: string; text: string; streaming: boolean };
export interface Recording {
  id: string; audio: string; sampleRate: number; startedAt: string; endedAt: string; confirmationId?: string;
}
export interface SavedCall {
  callId: string;
  options: CallOptions;
  recordings: Recording[];
  offsets: Record<string, number>;
  closed?: boolean;
}
export interface VoiceDependencies {
  request(input: CallRequest, signal: AbortSignal): Promise<SpeechResponse>;
  persistence: { read(): Promise<SavedCall | undefined>; write(call: SavedCall): Promise<void>; clear(): Promise<void> };
  audio: {
    unlock(): void;
    prepare(signal: AbortSignal): Promise<void>;
    ready(): Promise<void>;
    close(): void;
    finish(): void;
    capture(signal: AbortSignal): Promise<{ audio: string; sampleRate: number }>;
    play(audio: string, sampleRate: number, signal: AbortSignal): Promise<void>;
  };
  change(state: VoiceState, detail?: string, call?: CallStatus): void;
  id(): string;
}

/** Transport failures retain the outbox; only a server delivery acknowledgment removes it. */
export class ThreadVoiceSession {
  private saved?: SavedCall;
  private status?: CallStatus;
  private abort = new AbortController();
  private playback = new AbortController();
  private watching = new AbortController();
  private renew?: ReturnType<typeof setInterval>;
  private state: VoiceState = "idle";
  private active = false;
  private busy = false;
  private capture?: Promise<void>;
  private playbackTask?: Promise<void>;
  private running = false;
  private messages: readonly Message[] = [];
  private queue: { id: string; text: string; messageId?: string; end?: number }[] = [];
  private persistenceTail: Promise<void> = Promise.resolve();
  constructor(private deps: VoiceDependencies) {}
  private change(state: VoiceState, detail?: string) {
    this.state = state;
    this.deps.change(state, detail, this.status);
  }
  private persist() {
    const snapshot = structuredClone(this.saved!);
    this.persistenceTail = this.persistenceTail.catch(() => {}).then(() => this.deps.persistence.write(snapshot));
    return this.persistenceTail;
  }
  private async request(input: Omit<CallRequest, "callId">, signal = this.abort.signal) {
    const response = await this.deps.request({ ...input, callId: this.saved!.callId }, signal);
    if (response.call) this.status = response.call;
    return response;
  }
  private failed(error: unknown) {
    if (!this.active) return;
    this.playback.abort();
    this.watching.abort();
    clearInterval(this.renew);
    this.change("reconnecting", `${error instanceof Error ? error.message : "Connection lost."} Saved speech stays queued. Retry to resume.`);
  }
  async start(options: CallOptions, messages: readonly Message[]) {
    if (this.active) return;
    this.active = true;
    this.abort = new AbortController();
    this.playback = new AbortController();
    this.messages = messages;
    try {
      this.deps.audio.unlock();
      this.change("preparing", "Checking microphone and saved call");
      this.saved = await this.deps.persistence.read();
      if (!this.saved) {
        this.saved = { callId: this.deps.id(), options, recordings: [], offsets: Object.fromEntries(messages.map((message) => [message.id, message.text.length])) };
        await this.persist();
      }
      if (this.saved.options.threadId !== options.threadId) throw new Error("Saved call belongs to another chat.");
      await this.resume();
    } catch (error) { this.failed(error); }
  }
  async resume() {
    if (!this.active || this.busy || !this.saved) return;
    this.busy = true;
    try {
      this.playback = new AbortController();
      this.change("preparing", "Checking microphone");
      await this.deps.audio.prepare(this.abort.signal);
      this.change("preparing", "Opening call log and checking the selected Claude model");
      await this.request({ action: "call.open", options: this.saved.options });
      if (this.saved.closed) {
        await this.flush(false);
        await this.request({ action: "call.close" });
        await this.deps.persistence.clear();
        this.active = false;
        this.change("idle", "Previous call saved and ended. Start a new call.");
        return;
      }
      this.change("preparing", "Waiting for the router's speech profile");
      await this.request({ action: "call.prepare" });
      if (!this.active) return;
      await this.flush();
      clearInterval(this.renew);
      this.renew = setInterval(() => {
        void this.request({ action: "call.renew" }).catch((error) => this.failed(error));
      }, 60_000);
      await this.deps.audio.ready();
      this.change("ready", "Otis is ready");
      this.watching.abort();
      this.watching = new AbortController();
      void this.watch();
    } catch (error) { this.failed(error); }
    finally { this.busy = false; }
    if (this.state === "ready") {
      this.observe(this.messages, this.running);
      if (!this.running && !this.queue.length && !this.status?.pending.length) void this.listen();
    }
  }
  private async watch() {
    const signal = this.watching.signal;
    try {
      while (this.active && !signal.aborted && this.state !== "reconnecting") {
        await this.request({ action: "call.watch", version: this.status?.version }, signal);
        if (!this.active) return;
        for (const pending of this.status?.pending ?? []) {
          const id = `confirm-${pending.id}`;
          if (!this.status?.played.includes(id) && !this.queue.some((item) => item.id === id)) this.queue.push({ id, text: pending.summary });
        }
        this.change(this.state);
        if (!this.capture) void this.speak();
      }
    } catch (error) { if (!signal.aborted) this.failed(error); }
  }
  async listen() {
    if (!this.active || this.busy || this.capture || !["ready", "waiting"].includes(this.state)) return;
    const startedAt = new Date().toISOString();
    const confirmationId = this.status?.pending[0]?.id;
    this.change("listening");
    const capture = (async () => {
      try {
        const audio = await this.deps.audio.capture(this.abort.signal);
        if (!audio.audio) return;
        const recording: Recording = { ...audio, id: this.deps.id(), startedAt, endedAt: new Date().toISOString(), ...(confirmationId ? { confirmationId } : {}) };
        this.saved!.recordings.push(recording);
        await this.persist();
        this.change("saving", "Saving raw audio on the PC");
        await this.flush(this.active);
        if (this.active) this.change("waiting");
      } catch (error) { this.failed(error); }
      finally {
        this.capture = undefined;
        if (this.active && this.state !== "reconnecting") {
          if (this.queue.length) void this.speak();
          else if (!this.running) this.change("ready");
        }
      }
    })();
    this.capture = capture;
    return capture;
  }
  private async flush(deliver = true) {
    for (const recording of [...this.saved!.recordings]) {
      await this.request({ action: "call.upload", utteranceId: recording.id, ...recording });
      if (!deliver) continue;
      this.change("transcribing");
      await this.request({ action: "call.transcribe", utteranceId: recording.id });
      const response = await this.request({ action: "call.deliver", utteranceId: recording.id });
      if (response.utterance?.text?.trim() && !recording.confirmationId) this.running = true;
      this.saved!.recordings = this.saved!.recordings.filter((entry) => entry.id !== recording.id);
      await this.persist();
    }
  }
  finish() { this.deps.audio.finish(); }
  observe(messages: readonly Message[], running: boolean) {
    this.messages = messages;
    this.running = running;
    if (!this.active || !this.saved || ["preparing", "reconnecting"].includes(this.state)) return;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      let offset = this.saved.offsets[message.id] ?? 0;
      const queued = this.queue.filter((entry) => entry.messageId === message.id);
      if (queued.length) offset = Math.max(offset, ...queued.map((entry) => entry.end ?? 0));
      while (offset < message.text.length) {
        const rest = message.text.slice(offset);
        const text = rest.match(/^[\s\S]{1,1200}?[.!?](?:\s|$)/)?.[0] ?? (!message.streaming || rest.length >= 1200 ? rest.slice(0, 1200) : "");
        if (!text) break;
        const end = offset + text.length;
        // Message IDs may contain punctuation; deterministic numeric ranges need no URL encoding.
        const id = `s-${safeId(message.id)}-${offset}-${end}`;
        this.queue.push({ id, text, messageId: message.id, end });
        offset = end;
      }
    }
    if (!this.capture && !this.busy) void this.speak();
    if (!running && !this.queue.length && !this.capture && !this.busy && this.state === "waiting") {
      this.change("ready");
      void this.listen();
    }
  }
  private async speak() {
    if (this.playbackTask || !this.active || !this.queue.length || ["preparing", "reconnecting", "listening", "saving", "transcribing"].includes(this.state)) return;
    const signal = this.playback.signal;
    this.playbackTask = (async () => {
      try {
        while (this.queue.length && this.active && !signal.aborted) {
          const item = this.queue[0]!;
          this.change("speaking");
          if (!this.status?.played.includes(item.id)) {
            const result = await this.request({ action: "call.speak", speechId: item.id, text: item.text.replace(/[`#*_]/g, "") }, signal);
            signal.throwIfAborted();
            if (!result.audio || !result.sampleRate) throw new Error("Speech service returned no audio.");
            await this.deps.audio.play(result.audio, result.sampleRate, signal);
            signal.throwIfAborted();
            await this.request({ action: "call.played", speechId: item.id });
          }
          if (item.messageId) { this.saved!.offsets[item.messageId] = item.end!; await this.persist(); }
          this.queue.shift();
        }
        if (this.active && !signal.aborted) this.change(this.running && !this.status?.pending.length ? "waiting" : "ready");
      } catch (error) { if (!signal.aborted) this.failed(error); }
      finally { this.playbackTask = undefined; }
    })();
    await this.playbackTask;
    if (this.active && this.state === "ready") void this.listen();
  }
  async interrupt() {
    if (!this.active) return;
    this.playback.abort();
    this.queue = [];
    for (const message of this.messages) this.saved!.offsets[message.id] = message.text.length;
    await this.persist();
    try {
      await this.request({ action: "call.interrupt", utteranceId: this.deps.id() });
      await this.playbackTask;
      this.playback = new AbortController();
      this.change("ready");
      await this.listen();
    } catch (error) { this.failed(error); }
  }
  async confirm(decision: "yes" | "no") {
    const pending = this.status?.pending[0];
    if (!pending) return;
    try { await this.request({ action: "call.confirm", confirmationId: pending.id, decision }); }
    catch (error) { this.failed(error); }
  }
  async stop() {
    if (!this.saved) { this.active = false; this.deps.audio.close(); return; }
    this.active = false;
    this.playback.abort();
    clearInterval(this.renew);
    this.deps.audio.finish();
    await this.capture;
    this.saved.closed = true;
    await this.persist();
    try {
      await this.flush(false);
      await this.request({ action: "call.close" }, new AbortController().signal);
      await this.deps.persistence.clear();
      this.change("idle");
    } catch {
      this.change("error", "Call ended on this device. Reopen Call Otis to finish saving and close the PC session. Speech stays queued here.");
    } finally {
      this.abort.abort();
      this.watching.abort();
      this.queue = [];
      this.deps.audio.close();
    }
  }
}

// Stable encoding, including punctuation, avoids collisions between message IDs.
function safeId(value: string) {
  return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
