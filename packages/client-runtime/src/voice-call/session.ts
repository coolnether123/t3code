import type {
  CallOptions,
  CallRequest,
  CallStatus,
  SpeechResponse,
  ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

const now = () => DateTime.formatIso(Effect.runSync(DateTime.now));

export type VoiceState =
  | "idle"
  | "preparing"
  | "listening"
  | "saving"
  | "transcribing"
  | "waiting"
  | "speaking"
  | "ready"
  | "reconnecting"
  | "error";
type Message = {
  id: string;
  role: string;
  text: string;
  streaming: boolean;
  turnId?: string | null;
};
export interface Recording {
  id: string;
  audio: string;
  sampleRate: number;
  startedAt: string;
  endedAt: string;
  capturing?: boolean;
  modelSelection?: ModelSelection;
}
export interface SavedCall {
  callId: string;
  options: CallOptions;
  recordings: Recording[];
  offsets: Record<string, number>;
  closed?: boolean;
  silencedTurns?: string[];
  silencedMessages?: string[];
}
export interface VoiceDependencies {
  request(input: CallRequest, signal: AbortSignal): Promise<SpeechResponse>;
  persistence: {
    read(): Promise<SavedCall | undefined>;
    write(call: SavedCall): Promise<void>;
    clear(): Promise<void>;
  };
  audio: {
    unlock(): void;
    prepare(signal: AbortSignal): Promise<void>;
    ready(signal: AbortSignal): Promise<void>;
    close(): void;
    finish(): void;
    capture(
      signal: AbortSignal,
      journal?: (audio: { audio: string; sampleRate: number }) => Promise<void>,
    ): Promise<{ audio: string; sampleRate: number }>;
    play(audio: string, sampleRate: number, signal: AbortSignal): Promise<void>;
  };
  change(state: VoiceState, detail?: string, call?: CallStatus): void;
  id(): string;
}

/** Transport failures retain the outbox; only a server delivery acknowledgment removes it. */
export class ThreadVoiceSession {
  private saved: SavedCall | undefined;
  private status: CallStatus | undefined;
  private abort = new AbortController();
  private playback = new AbortController();
  private watching = new AbortController();
  private renew: Fiber.Fiber<never, never> | undefined;
  private state: VoiceState = "idle";
  private active = false;
  private busy = false;
  private detached = false;
  private recovering = false;
  private recording = false;
  private stopTask: Promise<void> | undefined;
  private capture: Promise<void> | undefined;
  private playbackTask: Promise<void> | undefined;
  private running = false;
  private turnId: string | undefined;
  private modelSelection: ModelSelection | undefined;
  private messages: readonly Message[] = [];
  private spokenText = new Map<string, { source: string; streaming: boolean; text: string }>();
  private queue: { text: string; messageId: string; start: number; end: number }[] = [];
  private persistenceTail: Promise<void> = Promise.resolve();
  private deps: VoiceDependencies;
  constructor(deps: VoiceDependencies) {
    this.deps = deps;
  }
  private change(state: VoiceState, detail?: string) {
    this.state = state;
    this.deps.change(state, detail, this.status);
  }
  private speechText(message: Message) {
    const cached = this.spokenText.get(message.id);
    if (cached?.source === message.text && cached.streaming === message.streaming)
      return cached.text;
    const text = spokenMessageText(message.text, message.streaming);
    this.spokenText.set(message.id, { source: message.text, streaming: message.streaming, text });
    return text;
  }
  private persist() {
    const snapshot = structuredClone(this.saved!);
    this.persistenceTail = this.persistenceTail
      .catch(() => {})
      .then(() => this.deps.persistence.write(snapshot));
    return this.persistenceTail;
  }
  private async request(input: Omit<CallRequest, "callId">, signal = this.abort.signal) {
    const response = await this.deps.request({ ...input, callId: this.saved!.callId }, signal);
    if (response.call) this.status = response.call;
    return response;
  }
  private failed(error: unknown) {
    if (!this.active) return;
    this.recovering = true;
    this.deps.audio.finish();
    this.playback.abort();
    this.watching.abort();
    if (this.renew) Effect.runFork(Fiber.interrupt(this.renew));
    const recoverable =
      error instanceof TypeError ||
      (error instanceof Error && "recoverable" in error && error.recoverable === true) ||
      (error instanceof Error &&
        "_tag" in error &&
        (error._tag === "RemoteEnvironmentAuthFetchError" ||
          error._tag === "RemoteEnvironmentAuthTimeoutError"));
    this.change(
      recoverable ? "reconnecting" : "error",
      `${error instanceof Error ? error.message : "Voice request failed."} Check the message above, then retry saved speech. Queued audio without a PC acknowledgment remains on this device.`,
    );
  }
  async start(options: CallOptions, messages: readonly Message[]) {
    if (this.active) return;
    this.active = true;
    this.modelSelection = options.modelSelection;
    this.abort = new AbortController();
    this.playback = new AbortController();
    this.messages = messages;
    try {
      this.deps.audio.unlock();
      this.change("preparing", "Checking microphone and saved call");
      this.saved = await this.deps.persistence.read();
      if (!this.active) return;
      if (!this.saved) {
        this.saved = this.newCall(options);
        await this.persist();
      }
      if (this.saved.options.threadId !== options.threadId)
        throw new Error("Saved call belongs to another chat.");
      for (const recording of this.saved.recordings) delete recording.capturing;
      await this.persist();
      await this.resume();
    } catch (error) {
      this.failed(error);
    }
  }
  private newCall(options: CallOptions): SavedCall {
    this.status = undefined;
    return {
      callId: this.deps.id(),
      options,
      recordings: [],
      offsets: Object.fromEntries(
        this.messages.map((message) => [message.id, this.speechText(message).length]),
      ),
    };
  }
  async resume() {
    if (!this.active || this.busy || !this.saved) return;
    this.busy = true;
    try {
      this.playback = new AbortController();
      this.change("preparing", "Opening call log and checking the selected chat model");
      await this.request({ action: "call.open", options: this.saved.options });
      if (!this.active) return;
      if (this.saved.closed || this.status?.closed) {
        this.saved.closed = true;
        await this.flush(false);
        await this.request({ action: "call.close" });
        await this.deps.persistence.clear();
        if (!this.active) return;
        this.saved = this.newCall({
          ...this.saved.options,
          modelSelection: this.modelSelection ?? this.saved.options.modelSelection,
        });
        await this.persist();
        await this.request({ action: "call.open", options: this.saved.options });
        if (!this.active) return;
      }
      this.change(
        "preparing",
        "Starting voice engines, about 3–5 minutes on a cold start. Waiting for the router to confirm they are ready.",
      );
      await this.request({
        action: "call.prepare",
        modelSelection: this.modelSelection ?? this.saved.options.modelSelection,
      });
      if (!this.active) return;
      this.recovering = false;
      this.startRenewal();
      this.change("preparing", "Checking microphone");
      await this.deps.audio.prepare(this.abort.signal);
      if (!this.active) return;
      await this.flush();
      if (!this.active || this.recovering) return;
      await this.deps.audio.ready(this.abort.signal);
      if (!this.active || this.recovering) return;
      this.change("ready", "Speech is ready");
      this.watching.abort();
      this.watching = new AbortController();
      void this.watch();
    } catch (error) {
      this.failed(error);
    } finally {
      this.busy = false;
    }
    if (this.state === "ready") {
      this.observe(this.messages, this.running, this.turnId, this.modelSelection);
      if (!this.running && !this.queue.length) void this.listen();
    }
  }
  private startRenewal() {
    if (this.renew) Effect.runFork(Fiber.interrupt(this.renew));
    this.renew = Effect.runFork(
      Effect.forever(
        Effect.delay(
          Effect.promise(() =>
            this.request({ action: "call.renew" }).catch((error) => this.failed(error)),
          ),
          "60 seconds",
        ),
      ),
    );
  }
  private async watch() {
    const signal = this.watching.signal;
    try {
      while (this.active && !signal.aborted && this.state !== "reconnecting") {
        await this.request({ action: "call.watch", version: this.status?.version }, signal);
        if (!this.active) return;
        if (this.status?.closed) {
          await this.stop();
          return;
        }
        if (this.status && !this.status.ready)
          throw Object.assign(
            new Error("Speech lease is unavailable. Retry to prepare it again."),
            { recoverable: true },
          );
        this.change(this.state);
        if (!this.capture) void this.speak();
      }
    } catch (error) {
      if (!signal.aborted) this.failed(error);
    }
  }
  async listen() {
    if (!this.active || this.busy || this.capture || !["ready", "waiting"].includes(this.state))
      return;
    if (this.saved!.recordings.some((recording) => !recording.capturing)) {
      this.busy = true;
      try {
        await this.flush();
        if (this.active && !this.recovering) this.change(this.running ? "waiting" : "ready");
      } catch (error) {
        this.failed(error);
      } finally {
        this.busy = false;
      }
      if (!this.active || this.recovering) return;
      if (this.queue.length) void this.speak();
      if (this.running || this.queue.length) return;
    }
    const startedAt = now();
    this.change("listening");
    const capture = (async () => {
      try {
        const id = this.deps.id();
        const journal = async (audio: { audio: string; sampleRate: number }) => {
          const recording: Recording = {
            ...audio,
            id,
            startedAt,
            endedAt: now(),
            capturing: true,
            modelSelection: this.modelSelection ?? this.saved!.options.modelSelection,
          };
          const index = this.saved!.recordings.findIndex((entry) => entry.id === id);
          if (index === -1) this.saved!.recordings.push(recording);
          else this.saved!.recordings[index] = recording;
          await this.persist();
        };
        this.recording = true;
        const audio = await this.deps.audio.capture(this.abort.signal, journal);
        this.recording = false;
        if (!audio.audio) return;
        const recording: Recording = {
          ...audio,
          id,
          startedAt,
          endedAt: now(),
          modelSelection: this.modelSelection ?? this.saved!.options.modelSelection,
        };
        this.saved!.recordings = this.saved!.recordings.filter((entry) => entry.id !== id);
        this.saved!.recordings.push(recording);
        await this.persist();
        if (!this.recovering) this.change("saving", "Saving raw audio on the PC");
        if (this.active && !this.detached && !this.recovering)
          await this.flush(this.queue.length === 0);
        if (this.active && !this.recovering) this.change("waiting");
      } catch (error) {
        this.failed(error);
      } finally {
        this.recording = false;
        this.capture = undefined;
        if (this.active && !["reconnecting", "error"].includes(this.state)) {
          if (this.queue.length) void this.speak();
          else if (!this.running) this.change("ready");
        }
      }
    })();
    this.capture = capture;
    return capture;
  }
  private async flush(deliver = true, signal = this.abort.signal) {
    for (const recording of this.saved!.recordings) {
      if (recording.capturing) continue;
      await this.request(
        { action: "call.upload", utteranceId: recording.id, ...recording },
        signal,
      );
      if (!deliver || !this.active || this.saved!.closed || this.recovering) continue;
      this.change("transcribing");
      await this.request({ action: "call.transcribe", utteranceId: recording.id }, signal);
      if (!this.active || this.saved!.closed || this.recovering) continue;
      const response = await this.request(
        { action: "call.deliver", utteranceId: recording.id },
        signal,
      );
      if (response.utterance?.text?.trim()) this.running = true;
      this.saved!.recordings = this.saved!.recordings.filter((entry) => entry.id !== recording.id);
      await this.persist();
    }
  }
  finish() {
    this.deps.audio.finish();
  }
  observe(
    messages: readonly Message[],
    running: boolean,
    turnId?: string,
    modelSelection?: ModelSelection,
  ) {
    this.messages = messages;
    this.running = running;
    this.turnId = turnId;
    if (modelSelection) this.modelSelection = modelSelection;
    if (!this.active || !this.saved || ["preparing", "reconnecting", "error"].includes(this.state))
      return;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (
        this.saved.silencedMessages?.includes(message.id) ||
        (message.turnId && this.saved.silencedTurns?.includes(message.turnId))
      )
        continue;
      const spoken = this.speechText(message);
      let offset = this.saved.offsets[message.id] ?? 0;
      const queued = this.queue.filter((entry) => entry.messageId === message.id);
      if (queued.length) offset = Math.max(offset, ...queued.map((entry) => entry.end ?? 0));
      while (offset < spoken.length) {
        const rest = spoken.slice(offset);
        const text =
          rest.match(/^[\s\S]{1,1200}?[.!?](?:\s|$)/)?.[0] ??
          (!message.streaming || rest.length >= 1200 ? rest.slice(0, 1200) : "");
        if (!text) break;
        const end = offset + text.length;
        this.queue.push({ text, messageId: message.id, start: offset, end });
        offset = end;
      }
    }
    if (this.capture && this.queue.length && this.recording) {
      // Finish retaining microphone input before speaking the queued reply.
      this.change("waiting");
      this.deps.audio.finish();
    }
    if (!this.capture && !this.busy) void this.speak();
    if (!running && !this.queue.length && !this.capture && !this.busy && this.state === "waiting") {
      this.change("ready");
      void this.listen();
    }
  }
  private async speak() {
    if (
      this.playbackTask ||
      !this.active ||
      !this.queue.length ||
      ["preparing", "reconnecting", "error", "listening", "saving", "transcribing"].includes(
        this.state,
      )
    )
      return;
    const signal = this.playback.signal;
    this.playbackTask = (async () => {
      try {
        while (this.queue.length && this.active && !signal.aborted) {
          const item = this.queue[0]!;
          const id = await speechIdentifier(item.messageId, item.start, item.end);
          signal.throwIfAborted();
          this.change("speaking");
          if (!this.status?.played.includes(id)) {
            const result = await this.request(
              { action: "call.speak", speechId: id, text: item.text.replace(/[#*_]/g, "") },
              signal,
            );
            signal.throwIfAborted();
            if (!result.played && (!result.audio || !result.sampleRate))
              throw new Error("Speech service returned no audio.");
            if (!result.played)
              await this.deps.audio.play(result.audio!, result.sampleRate!, signal);
            signal.throwIfAborted();
            await this.request({ action: "call.played", speechId: id });
          }
          if (item.messageId) {
            this.saved!.offsets[item.messageId] = item.end!;
            await this.persist();
          }
          this.queue.shift();
        }
        if (this.active && !signal.aborted) this.change(this.running ? "waiting" : "ready");
      } catch (error) {
        if (!signal.aborted) this.failed(error);
      } finally {
        this.playbackTask = undefined;
      }
    })();
    await this.playbackTask;
    if (this.active && this.state === "ready") void this.listen();
  }
  async interrupt() {
    if (!this.active) return;
    this.playback.abort();
    this.queue = [];
    this.saved!.silencedTurns = [
      ...new Set([
        ...(this.saved!.silencedTurns ?? []),
        ...this.messages
          .filter((message) => message.streaming && message.turnId)
          .map((message) => message.turnId!),
        ...(this.turnId ? [this.turnId] : []),
      ]),
    ];
    this.saved!.silencedMessages = [
      ...new Set([
        ...(this.saved!.silencedMessages ?? []),
        ...this.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.id),
      ]),
    ];
    for (const message of this.messages)
      this.saved!.offsets[message.id] = this.speechText(message).length;
    await this.persist();
    try {
      await this.request({ action: "call.interrupt", utteranceId: this.deps.id() });
      await this.playbackTask;
      this.playback = new AbortController();
      this.change("ready");
      void this.listen();
    } catch (error) {
      this.failed(error);
    }
  }
  async detach() {
    this.detached = true;
    this.active = false;
    this.playback.abort();
    this.watching.abort();
    if (this.renew) Effect.runFork(Fiber.interrupt(this.renew));
    this.deps.audio.finish();
    if (!this.recording) this.abort.abort();
    await this.capture;
    this.abort.abort();
    this.queue = [];
    this.deps.audio.close();
  }
  stop() {
    this.stopTask ??= this.hangUp().finally(() => {
      this.stopTask = undefined;
    });
    return this.stopTask;
  }
  private async hangUp() {
    this.active = false;
    this.playback.abort();
    this.watching.abort();
    if (!this.recording) this.abort.abort();
    if (!this.saved) {
      this.deps.audio.close();
      this.change("idle");
      return;
    }
    this.active = false;
    this.playback.abort();
    if (this.renew) Effect.runFork(Fiber.interrupt(this.renew));
    this.deps.audio.finish();
    await this.capture;
    this.abort.abort();
    try {
      this.saved.closed = true;
      await this.persist();
      await this.flush(false, new AbortController().signal);
      await this.request({ action: "call.close" }, new AbortController().signal);
      await this.deps.persistence.clear();
      this.change("idle");
    } catch {
      this.change(
        "error",
        "Call ended on this device. Reopen Call Otis to finish saving and close the PC session. Speech stays queued here.",
      );
    } finally {
      this.abort.abort();
      this.watching.abort();
      this.queue = [];
      this.deps.audio.close();
    }
  }
}

// Hash the message and explicit range together; wire IDs stay 66 characters.
export async function speechIdentifier(value: string, start: number, end: number) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([value, start, end])),
  );
  return (
    "s-" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

function spokenMessageText(value: string, streaming = false) {
  const text = value
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/`[^`]*(?:`|$)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  let output = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (!depth) {
      if (char === "{" || char === "[") depth = 1;
      else output += char;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === "{" || char === "[")) depth++;
    if (!quoted && (char === "}" || char === "]")) depth--;
  }
  return output.trim() || streaming || !value.trim() ? output : "I've put the details in the chat.";
}
