import type {
  CallOptions,
  CallRequest,
  CallStatus,
  SpeechResponse,
  ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { isRetryableVoiceError, VoiceRequestError } from "./errors.ts";
import { FILLER_DELAY_MS, TurnFiller } from "./filler.ts";
import { voiceRequestTimeoutMs } from "./timeouts.ts";
import { SpeechBoundaryTrimmer } from "./speechBoundary.ts";

const now = () => DateTime.formatIso(Effect.runSync(DateTime.now));
const time = () => Effect.runSync(Clock.currentTimeMillis);

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
  voiceDelegation?: boolean;
};
export interface Recording {
  id: string;
  audio: string;
  sampleRate: number;
  startedAt: string;
  endedAt: string;
  capturing?: boolean;
  modelSelection?: ModelSelection;
  operatorSelection?: ModelSelection;
}
export interface SavedCall {
  callId: string;
  options: CallOptions;
  recordings: Recording[];
  offsets: Record<string, number>;
  typed?: {
    id: string;
    retryOf?: { callId: string; utteranceId: string };
    text: string;
    modelSelection: ModelSelection;
    operatorSelection?: ModelSelection;
  }[];
  readyAnnounced?: boolean;
  closed?: boolean;
  silencedTurns?: string[];
  silencedMessages?: string[];
  acknowledgedDelegations?: string[];
}
export interface VoiceDependencies {
  ensureThread?(options: CallOptions): Promise<void>;
  speechEvent?(
    event:
      | { type: "sentence"; messageId: string; start: number; end: number }
      | { type: "audio"; speechId: string }
      | { type: "retry"; action: CallRequest["action"]; attempt: number },
  ): void;
  request(
    input: CallRequest,
    signal: AbortSignal,
    onAudio?: (chunk: { audio: string; sampleRate: number }) => void,
  ): Promise<SpeechResponse>;
  persistence: {
    read(): Promise<SavedCall | undefined>;
    write(call: SavedCall): Promise<void>;
    clear(): Promise<void>;
  };
  audio: {
    unlock(): void;
    prepare(signal: AbortSignal, inputMode?: "pc" | "device"): Promise<void>;
    captureText?(signal: AbortSignal): Promise<string | null>;
    ready(signal: AbortSignal): Promise<void>;
    close(): void;
    finish(): void;
    finishAtPause(): void;
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
  private renewal = new AbortController();
  private state: VoiceState = "idle";
  private active = false;
  private opened = false;
  private typing = false;
  private preparingAt = 0;
  private initialized: Promise<void> = Promise.resolve();
  private initialize: (() => void) | undefined;
  private busy = false;
  private detached = false;
  private recovering = false;
  private audioNeedsTap = false;
  private recording = false;
  private deviceUnavailable = false;
  private recordingId: string | undefined;
  private filler: TurnFiller;
  private pendingFiller: { id: string; endedAt: number } | undefined;
  private acknowledgment: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private closeRetry = new AbortController();
  private capture: Promise<void> | undefined;
  private playbackTask: Promise<void> | undefined;
  private running = false;
  private turnId: string | undefined;
  private modelSelection: ModelSelection | undefined;
  private operatorSelection: ModelSelection | undefined;
  private announcing = false;
  private messages: readonly Message[] = [];
  private spokenText = new Map<string, { source: string; streaming: boolean; text: string }>();
  private queue: { text: string; messageId: string; start: number; end: number }[] = [];
  private persistenceTail: Promise<void> = Promise.resolve();
  private deps: VoiceDependencies;
  constructor(deps: VoiceDependencies) {
    this.deps = deps;
    this.filler = new TurnFiller((audio, rate, signal) => deps.audio.play(audio, rate, signal));
  }
  private change(state: VoiceState, detail?: string) {
    this.state = state;
    this.deps.change(
      state,
      detail ??
        (state === "ready" && this.deviceUnavailable
          ? "Voice input is unavailable right now. Type to Otis instead."
          : undefined),
      this.status,
    );
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
  private async request(
    input: Omit<CallRequest, "callId">,
    signal = this.abort.signal,
    onAudio?: (chunk: { audio: string; sampleRate: number }) => void,
  ) {
    const request = { ...input, callId: this.saved!.callId };
    const send = async () => {
      if (request.callId !== this.saved?.callId)
        throw new VoiceRequestError("The call changed. Your words remain queued.", false);
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let aborted: (() => void) | undefined;
      try {
        return await new Promise<SpeechResponse>((resolve, reject) => {
          // @effect-diagnostics-next-line globalTimers:off -- Bound transports that may ignore cancellation.
          timeout = setTimeout(
            () => {
              const error = new VoiceRequestError(
                "Voice request timed out. Retrying; your words are saved.",
                true,
              );
              controller.abort(error);
              reject(error);
            },
            voiceRequestTimeoutMs(input.action, input.streamAudio),
          );
          aborted = () => {
            controller.abort(signal.reason);
            reject(signal.reason);
          };
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
          Promise.resolve()
            .then(() => {
              controller.signal.throwIfAborted();
              return this.deps.request(
                request,
                controller.signal,
                ...(onAudio ? ([onAudio] as const) : []),
              );
            })
            .then(resolve, reject);
        });
      } finally {
        clearTimeout(timeout);
        if (aborted) signal.removeEventListener("abort", aborted);
      }
    };
    // A synthesis retry owns its audio nodes; control requests never cancel playback.
    const response =
      input.action === "call.speak" ? await send() : await this.retry(input.action, signal, send);
    if (response.call && request.callId === this.saved?.callId) {
      this.status = response.call;
      if (
        this.active &&
        this.status.ready &&
        !this.status.closed &&
        !this.busy &&
        !["preparing", "reconnecting", "error"].includes(this.state)
      ) {
        this.change(this.state);
        if (this.capture && this.hasUnannouncedUpdates()) this.deps.audio.finishAtPause();
        if (!this.capture) void this.announceAtPause();
      }
    }
    return response;
  }
  private async retry<A>(
    action: CallRequest["action"],
    signal: AbortSignal,
    send: () => Promise<A>,
  ): Promise<A> {
    let attempt = 0;
    for (;;) {
      signal.throwIfAborted();
      try {
        const result = await send();
        if (attempt && this.active) this.change(this.state);
        return result;
      } catch (error) {
        if (!this.active || signal.aborted || !isRetryableVoiceError(error)) throw error;
        attempt++;
        this.deps.speechEvent?.({ type: "retry", action, attempt });
        this.change(
          this.state,
          "Connection interrupted. Retrying automatically; speech is still queued.",
        );
        await Effect.runPromise(
          Effect.sleep(Math.min(10_000, 250 * 2 ** Math.min(attempt - 1, 6))),
          { signal },
        );
      }
    }
  }
  private failed(error: unknown) {
    if (!this.active) return;
    this.recovering = true;
    this.filler.cancel();
    this.pendingFiller = undefined;
    this.deps.audio.finish();
    this.playback.abort();
    this.watching.abort();
    this.stopRenewal();
    const recoverable = isRetryableVoiceError(error);
    this.change(
      recoverable ? "reconnecting" : "error",
      this.audioNeedsTap
        ? "Audio paused by the phone. Stop other audio, then tap Retry."
        : `${error instanceof Error ? error.message : "Voice request failed."} Your unsent words are saved. Tap Retry.`,
    );
  }
  audioInterrupted() {
    this.audioNeedsTap = true;
    if (this.recovering) return;
    this.failed(
      new VoiceRequestError("Audio paused by the phone. Stop other audio, then tap Retry.", false),
    );
  }
  async start(options: CallOptions, messages: readonly Message[]) {
    if (this.active) return;
    if (this.stopTask) await this.stopTask;
    this.closeRetry.abort();
    this.active = true;
    this.deviceUnavailable = false;
    this.opened = false;
    this.preparingAt = time();
    this.initialized = new Promise<void>((resolve) => {
      this.initialize = resolve;
    });
    this.modelSelection = options.modelSelection;
    this.operatorSelection = options.operatorSelection;
    this.abort = new AbortController();
    this.playback = new AbortController();
    this.messages = messages;
    try {
      this.deps.audio.unlock();
      this.change("preparing", "Checking microphone and saved call");
      await this.deps.ensureThread?.(options);
      if (!this.active) return;
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
      this.initialize?.();
      await this.resume();
    } catch (error) {
      this.failed(error);
    } finally {
      this.initialize?.();
    }
  }
  private newCall(options: CallOptions): SavedCall {
    this.status = undefined;
    return {
      callId: this.deps.id(),
      options,
      recordings: [],
      acknowledgedDelegations: this.messages.map((message) => message.id),
      offsets: Object.fromEntries(
        this.messages.map((message) => [message.id, this.speechText(message).length]),
      ),
    };
  }
  async resume(userInitiated = true) {
    if (this.audioNeedsTap && !userInitiated) return;
    if (!this.active && this.saved?.closed && !this.detached) {
      await this.stop();
      return;
    }
    if (!this.active || this.busy || !this.saved) return;
    // An online event must not replace controllers owned by active request retries.
    if (!this.recovering && this.state !== "preparing") return;
    this.busy = true;
    try {
      if (this.recovering) {
        this.deps.audio.unlock();
        await this.capture;
        await this.playbackTask;
        if (!this.active) return;
      }
      this.playback = new AbortController();
      this.change("preparing", "Opening call log and checking the selected chat model");
      await this.request({ action: "call.open", options: this.saved.options });
      if (!this.active) return;
      if (this.saved.closed || this.status?.closed) {
        const oldCallId = this.saved.callId;
        const delivered = new Set(
          this.status?.utterances.filter((item) => item.deliveredAt).map((item) => item.id),
        );
        const pending = (this.saved.typed ?? []).filter((item) => !delivered.has(item.id));
        this.saved.closed = true;
        await this.request({ action: "call.close" });
        await this.flush(false);
        if (!this.active) return;
        this.saved = this.newCall({
          ...this.saved.options,
          modelSelection: this.modelSelection ?? this.saved.options.modelSelection,
        });
        this.saved.typed = pending.map((item) => ({
          ...item,
          retryOf: item.retryOf ?? { callId: oldCallId, utteranceId: item.id },
          id: this.deps.id(),
        }));
        this.opened = false;
        this.status = undefined;
        this.running = false;
        await this.persist();
        await this.request({ action: "call.open", options: this.saved.options });
        if (!this.active) return;
      }
      this.opened = true;
      await this.flushTyped();
      this.change(
        "preparing",
        "Starting voice engines, about 3 to 5 minutes on a cold start. Waiting for the router to confirm they are ready.",
      );
      await this.request({
        action: "call.prepare",
        modelSelection: this.modelSelection ?? this.saved.options.modelSelection,
        ...(this.operatorSelection ? { operatorSelection: this.operatorSelection } : {}),
      });
      if (!this.active) return;
      this.recovering = false;
      this.startRenewal();
      this.change("preparing", "Checking microphone");
      await this.deps.audio.prepare(this.abort.signal, this.status?.inputMode);
      this.audioNeedsTap = false;
      if (!this.active) return;
      await this.flush();
      if (!this.active || this.recovering) return;
      await this.filler.prepare();
      if (!this.active || this.recovering) return;
      await this.deps.audio.ready(this.playback.signal);
      if (time() - this.preparingAt > 4000 && !this.saved.readyAnnounced) {
        this.saved.readyAnnounced = true;
        await this.persist();
        await this.playSentence("call-ready", "I'm here.", this.playback.signal);
      }
      if (!this.active || this.recovering) return;
      this.change("ready", "Speech is ready");
      this.watching.abort();
      this.watching = new AbortController();
      void this.watch();
    } catch (error) {
      this.failed(error);
      if (error instanceof Error && /This call has ended/.test(error.message))
        queueMicrotask(() => void this.resume(false));
    } finally {
      this.busy = false;
    }
    if (this.state === "ready") {
      this.observe(this.messages, this.running, this.turnId, this.modelSelection);
      if (!this.running && !this.queue.length) void this.listen();
    }
  }
  async say(text: string) {
    if (!this.active || !text.trim()) throw new Error("Start a call before typing to Otis.");
    await this.initialized;
    if (!this.active || !this.saved || this.saved.closed)
      throw new Error("The call could not open. Retry the call, then send again.");
    await this.queueTyped(text);
    if (this.capture) this.deps.audio.finishAtPause();
    void this.flushTyped().catch((error) => this.failed(error));
  }
  private async queueTyped(text: string) {
    const item = {
      id: this.deps.id(),
      text: text.trim(),
      modelSelection: this.modelSelection ?? this.saved!.options.modelSelection,
      ...(this.operatorSelection ? { operatorSelection: this.operatorSelection } : {}),
    };
    (this.saved!.typed ??= []).push(item);
    await this.persist();
    return item.id;
  }
  private async flushTyped() {
    if (
      !this.opened ||
      this.typing ||
      this.running ||
      !this.active ||
      this.saved?.closed ||
      (this.status?.inputMode !== "device" &&
        this.saved?.recordings.some((recording) => !recording.capturing)) ||
      this.capture ||
      this.queue.length ||
      this.playbackTask ||
      (this.busy && this.state !== "preparing")
    )
      return;
    const item = this.saved?.typed?.[0];
    if (!item) return;
    this.typing = true;
    const callId = this.saved!.callId;
    try {
      const response = await this.request({ action: "call.say", utteranceId: item.id, ...item });
      if (callId !== this.saved?.callId) return;
      if (response.call?.closed)
        throw new Error("This call has ended. Reconnecting with your saved words.");
      if (!response.utterance?.deliveredAt) throw new Error("Typed turn was not acknowledged.");
      this.running = true;
      this.saved!.typed = this.saved!.typed!.filter((entry) => entry.id !== item.id);
      await this.persist();
      if (this.state !== "preparing") this.change("waiting");
    } catch (error) {
      if (callId !== this.saved?.callId) return;
      if (error instanceof Error && /This call has ended/.test(error.message)) {
        if (this.busy) throw error;
        this.failed(new Error("Call ended. Reconnecting with your saved words."));
        // The outbox stays on the old identity until resume reconciles delivery receipts.
        queueMicrotask(() => void this.resume(false));
        return;
      }
      throw error;
    } finally {
      this.typing = false;
      if (this.active && callId !== this.saved?.callId) {
        this.deps.audio.finishAtPause();
        void this.flushTyped().catch((error) => this.failed(error));
      }
    }
  }
  private startRenewal() {
    this.stopRenewal();
    this.renewal = new AbortController();
    const signal = this.renewal.signal;
    // The call owns the lease, including time spent listening or waiting for work.
    Effect.runFork(
      Effect.forever(
        Effect.delay(
          Effect.promise(() =>
            this.request({ action: "call.renew" }, signal).catch((error) => {
              if (!signal.aborted) this.failed(error);
            }),
          ),
          "60 seconds",
        ),
        // Each iteration already yields for a minute and for the HTTP request.
        { disableYield: true },
      ),
      { signal },
    );
  }
  private stopRenewal() {
    this.renewal.abort();
  }
  private async watch() {
    const signal = this.watching.signal;
    try {
      while (this.active && !signal.aborted && this.state !== "reconnecting") {
        await this.request({ action: "call.watch", version: this.status?.version }, signal);
        if (!this.active) return;
        if (this.status?.closed) {
          this.failed(new Error("Call ended. Reconnecting with your saved words."));
          void this.resume(false);
          return;
        }
        if (this.status && !this.status.ready)
          throw Object.assign(
            new Error("Speech lease is unavailable. Retry to prepare it again."),
            { recoverable: true },
          );
        if (!this.capture) void this.speak();
      }
    } catch (error) {
      if (!signal.aborted) this.failed(error);
    }
  }
  async listen() {
    if (
      !this.active ||
      this.busy ||
      this.announcing ||
      this.filler.isPlaying ||
      this.acknowledgment ||
      this.capture ||
      !["ready", "waiting"].includes(this.state)
    )
      return;
    if (
      this.status?.inputMode !== "device" &&
      this.saved!.recordings.some((recording) => !recording.capturing)
    ) {
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
    if (this.hasUnannouncedUpdates()) {
      await this.announceAtPause();
      if (!this.active || this.running || this.announcing || this.recovering) return;
    }
    if (this.status?.inputMode === "device") return this.listenDevice();
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
            ...(this.operatorSelection ? { operatorSelection: this.operatorSelection } : {}),
          };
          const index = this.saved!.recordings.findIndex((entry) => entry.id === id);
          if (index === -1) this.saved!.recordings.push(recording);
          else this.saved!.recordings[index] = recording;
          await this.persist();
        };
        this.recording = true;
        this.recordingId = id;
        const audio = await this.deps.audio.capture(this.abort.signal, journal);
        this.recording = false;
        if (!audio.audio) {
          this.filler.cancel();
          this.pendingFiller = undefined;
          this.saved!.recordings = this.saved!.recordings.filter((entry) => entry.id !== id);
          await this.persist();
          return;
        }
        this.scheduleFiller(id);
        const recording: Recording = {
          ...audio,
          id,
          startedAt,
          endedAt: now(),
          modelSelection: this.modelSelection ?? this.saved!.options.modelSelection,
          ...(this.operatorSelection ? { operatorSelection: this.operatorSelection } : {}),
        };
        this.saved!.recordings = this.saved!.recordings.filter((entry) => entry.id !== id);
        this.saved!.recordings.push(recording);
        await this.persist();
        if (this.active && !this.recovering) this.change("saving", "Saving raw audio on the PC");
        if (this.active && !this.detached && !this.recovering)
          await this.flush(this.queue.length === 0);
        if (this.active && !this.recovering) this.change("waiting");
      } catch (error) {
        this.failed(error);
      } finally {
        this.recording = false;
        this.recordingId = undefined;
        this.capture = undefined;
        void this.flushTyped().catch((error) => this.failed(error));
        if (this.active && !["reconnecting", "error"].includes(this.state)) {
          this.change(this.running ? "waiting" : "ready");
          if (this.queue.length) void this.speak();
          if (!this.queue.length && !this.running) void this.announceAtPause();
        }
      }
    })();
    this.capture = capture;
    return capture;
  }
  private async listenDevice() {
    if (!this.deps.audio.captureText) {
      this.deviceUnavailable = true;
      this.change("ready", "Voice input is unavailable right now. Type to Otis instead.");
      return;
    }
    this.change("listening");
    const capture = (async () => {
      let text: string | null = null;
      try {
        text = await this.deps.audio.captureText!(this.abort.signal);
        this.deviceUnavailable = text === null;
        if (text?.trim()) {
          const id = await this.queueTyped(text);
          this.scheduleFiller(id);
        }
      } catch (error) {
        this.failed(error);
      } finally {
        this.capture = undefined;
      }
      if (!this.active || this.recovering) return;
      if (text === null) {
        this.change("ready", "Voice input is unavailable right now. Type to Otis instead.");
        return;
      }
      this.change(this.running ? "waiting" : "ready");
      await this.flushTyped();
      if (this.queue.length) void this.speak();
      else if (!this.running) {
        await this.announceAtPause();
        if (!this.running && !this.announcing) void this.listen();
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
      if (
        !deliver ||
        this.status?.inputMode === "device" ||
        !this.active ||
        this.saved!.closed ||
        this.recovering
      )
        continue;
      this.change("transcribing");
      await this.request({ action: "call.transcribe", utteranceId: recording.id }, signal);
      if (!this.active || this.saved!.closed || this.recovering || this.running) continue;
      const response = await this.request(
        { action: "call.deliver", utteranceId: recording.id },
        signal,
      );
      if (!response.utterance?.deliveredAt) throw new Error("Voice turn was not acknowledged.");
      if (response.utterance.text?.trim()) this.running = true;
      this.saved!.recordings = this.saved!.recordings.filter((entry) => entry.id !== recording.id);
      await this.persist();
    }
  }
  finish() {
    if (this.recordingId) this.scheduleFiller(this.recordingId);
    this.deps.audio.finish();
  }
  private scheduleFiller(id: string) {
    if (!this.active || this.recovering) return;
    this.pendingFiller ??= { id, endedAt: time() };
  }
  observe(
    messages: readonly Message[],
    running: boolean,
    turnId?: string,
    modelSelection?: ModelSelection,
    operatorSelection?: ModelSelection,
  ) {
    this.messages = messages;
    this.running = running || this.status?.voiceRunning === true;
    this.turnId = turnId;
    if (modelSelection) this.modelSelection = modelSelection;
    if (operatorSelection) this.operatorSelection = operatorSelection;
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
      const delegated =
        message.voiceDelegation || /<otis-delegate>[\s\S]*?<\/otis-delegate>/.test(message.text);
      const needsAcknowledgment =
        delegated &&
        !message.streaming &&
        !spoken.trim() &&
        !this.saved.acknowledgedDelegations?.includes(message.id);
      if ((spoken.slice(offset).trim() || needsAcknowledgment) && this.pendingFiller) {
        const pending = this.pendingFiller;
        this.pendingFiller = undefined;
        const filler = this.filler.arm(
          pending.id,
          this.playback.signal,
          needsAcknowledgment ? FILLER_DELAY_MS : time() - pending.endedAt,
        );
        if (needsAcknowledgment) {
          (this.saved.acknowledgedDelegations ??= []).push(message.id);
          void this.persist().catch((error) => this.failed(error));
          this.acknowledgment = filler;
          void filler.finally(() => {
            if (this.acknowledgment === filler) this.acknowledgment = undefined;
            if (this.active && !this.running) void this.listen();
          });
        }
      }
      const queued = this.queue.filter((entry) => entry.messageId === message.id);
      if (queued.length) offset = Math.max(offset, ...queued.map((entry) => entry.end ?? 0));
      while (offset < spoken.length && this.queue.length < 3) {
        const rest = spoken.slice(offset);
        // Keep available context in one utterance. Streaming text still yields its
        // first complete sentence immediately; later text is prefetched during playback.
        const available = rest.slice(0, 1200);
        const boundaries = [...available.matchAll(/[.!?]["')\]]*(?:\s|$)/g)];
        const boundary = offset === 0 && message.streaming ? boundaries[0] : boundaries.at(-1);
        const text =
          !message.streaming && rest.length <= 1200
            ? rest
            : boundary
              ? available.slice(0, boundary.index + boundary[0].length)
              : rest.length >= 1200
                ? available
                : "";
        if (!text) break;
        const end = offset + text.length;
        const cleaned = text.replace(/[#*_]/g, "");
        if (cleaned.trim()) {
          this.queue.push({ text: cleaned, messageId: message.id, start: offset, end });
          this.deps.speechEvent?.({ type: "sentence", messageId: message.id, start: offset, end });
        } else if (!this.queue.some((entry) => entry.messageId === message.id)) {
          // Do not advance past earlier speech that still needs to play.
          this.saved.offsets[message.id] = end;
          void this.persist().catch((error) => this.failed(error));
        }
        offset = end;
      }
    }
    if (this.capture && this.queue.length && this.recording) {
      this.deps.audio.finishAtPause();
    }
    this.prefetchSpeech?.();
    if (!this.capture && !this.busy) void this.speak();
    if (!this.running && !this.queue.length)
      void this.flushTyped().catch((error) => this.failed(error));
    if (!this.running && !this.queue.length && !this.capture && !this.busy) {
      this.pendingFiller = undefined;
      if (!this.acknowledgment) this.filler.cancel();
      void this.acknowledgeUpdates().catch((error) => this.failed(error));
      void this.announceAtPause();
    }
    if (
      !this.running &&
      !this.queue.length &&
      !this.capture &&
      !this.busy &&
      this.state === "waiting"
    ) {
      this.change("ready");
      void this.listen();
    }
  }
  private async announceAtPause() {
    if (
      !this.active ||
      this.announcing ||
      this.capture ||
      this.busy ||
      this.running ||
      this.queue.length ||
      this.playbackTask ||
      !this.hasUnannouncedUpdates()
    )
      return;
    this.announcing = true;
    this.running = true;
    try {
      const result = await this.request({ action: "call.announce" });
      this.running = result.announced === true;
      this.change(this.running ? "waiting" : "ready");
    } catch (error) {
      this.failed(error);
    } finally {
      this.announcing = false;
    }
  }
  private hasUnannouncedUpdates() {
    return this.status?.operatorUpdates?.some(
      (update) =>
        !update.heardAt &&
        !update.announcementId &&
        (update.status === "done" || update.status === "needs-Jared"),
    );
  }
  private async acknowledgeUpdates() {
    if (this.running || this.queue.length || !this.saved) return;
    const heard =
      this.status?.operatorUpdates
        ?.filter((update) => {
          if (update.heardAt || !update.announcementTurnId) return false;
          const replies = this.messages.filter(
            (message) =>
              message.role === "assistant" && message.turnId === update.announcementTurnId,
          );
          return (
            replies.length > 0 &&
            replies.every(
              (message) =>
                !message.streaming &&
                this.speechText(message).trim() &&
                (this.saved!.offsets[message.id] ?? 0) >= this.speechText(message).length &&
                !this.saved!.silencedMessages?.includes(message.id),
            )
          );
        })
        .map((update) => update.id) ?? [];
    if (heard.length) await this.request({ action: "call.heard", updateIds: heard });
  }
  private prefetchSpeech: (() => void) | undefined;
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
    const pipeline = new AbortController();
    const signal = AbortSignal.any([this.playback.signal, pipeline.signal]);
    const generation = this.deps.id();
    const output = this.deps.audio as VoiceDependencies["audio"] &
      Partial<import("./playback.ts").SpeechPlaybackAudio>;
    output.beginPlayback?.(generation);
    this.playbackTask = (async () => {
      type Item = (typeof this.queue)[number];
      const prepare = async (item: Item) => {
        const id = await speechIdentifier(item.messageId, item.start, item.end);
        signal.throwIfAborted();
        const audio = this.status?.played.includes(id)
          ? { playback: Promise.resolve() }
          : await this.playSentence(id, item.text, signal, generation, {
              start: (item.start ?? 0) > 0,
              end: () =>
                this.messages.some(
                  (message) =>
                    message.id === item.messageId &&
                    this.speechText(message).slice(item.end).trim().length > 0,
                ),
            });
        return { id, ...audio };
      };
      let next: { item: Item; audio: ReturnType<typeof prepare> } | undefined;
      let generated = false;
      const prefetch = () => {
        const item = this.queue[1];
        if (!generated || next || !item || signal.aborted) return;
        const audio = prepare(item);
        next = { item, audio };
        void audio.catch(() => {});
      };
      this.prefetchSpeech = prefetch;
      try {
        while (this.queue.length && this.active && !signal.aborted) {
          const item = this.queue[0]!;
          generated = false;
          const audio = await (next?.item === item ? next.audio : prepare(item));
          next = undefined;
          generated = true;
          signal.throwIfAborted();
          this.change("speaking");
          prefetch();
          await audio.playback;
          if (!this.status?.played.includes(audio.id)) {
            // Retry the acknowledgment separately, without replaying audio already heard.
            await this.request({ action: "call.played", speechId: audio.id }, signal);
          }
          if (item.messageId) {
            this.saved!.offsets[item.messageId] = item.end!;
            await this.persist();
          }
          generated = false;
          this.queue.shift();
          this.observe(this.messages, this.running, this.turnId, this.modelSelection);
        }
        await this.acknowledgeUpdates();
        if (this.active && !signal.aborted) this.change(this.running ? "waiting" : "ready");
      } catch (error) {
        if (!signal.aborted) this.failed(error);
      } finally {
        this.prefetchSpeech = undefined;
        pipeline.abort();
        await next?.audio.catch(() => {});
        this.playbackTask = undefined;
      }
    })();
    await this.playbackTask;
    if (this.active && this.state === "ready") {
      await this.flushTyped();
      void this.listen();
    }
  }
  private async playSentence(
    id: string,
    text: string,
    signal: AbortSignal,
    generation?: string,
    boundary?: { start: boolean; end: () => boolean },
  ) {
    const pipelined = generation !== undefined;
    const responseGeneration = generation ?? this.deps.id();
    const output = this.deps.audio as VoiceDependencies["audio"] &
      Partial<import("./playback.ts").SpeechPlaybackAudio>;
    if (!pipelined) output.beginPlayback?.(responseGeneration);
    const audio = await this.retry("call.speak", signal, async () => {
      const attempt = new AbortController();
      const audioSignal = AbortSignal.any([signal, attempt.signal]);
      const attemptId = this.deps.id();
      const chunks: Promise<void>[] = [];
      let trimmer: SpeechBoundaryTrimmer | undefined;
      let sampleRate: number | undefined;
      const play = (chunk: { audio: string; sampleRate: number }) => {
        audioSignal.throwIfAborted();
        this.filler.startReply();
        this.deps.speechEvent?.({ type: "audio", speechId: id });
        return output.play(chunk.audio, chunk.sampleRate, audioSignal, {
          generation: responseGeneration,
          speechId: id,
          attemptId,
        });
      };
      try {
        this.change("speaking");
        const result = await this.request(
          {
            action: "call.speak",
            speechId: id,
            text,
            streamAudio: true,
            generation: responseGeneration,
          },
          audioSignal,
          (chunk) => {
            audioSignal.throwIfAborted();
            if (sampleRate !== undefined && sampleRate !== chunk.sampleRate)
              throw new Error("Speech sample rate changed during synthesis.");
            sampleRate = chunk.sampleRate;
            if (boundary && (trimmer || boundary.start || boundary.end()))
              trimmer ??= new SpeechBoundaryTrimmer(chunk.sampleRate, boundary.start);
            const audio = trimmer ? trimmer.push(chunk.audio) : chunk.audio;
            if (!audio) return;
            const played = play({ audio, sampleRate: chunk.sampleRate });
            chunks.push(played);
            void played.catch((error) => attempt.abort(error));
          },
        );
        audioSignal.throwIfAborted();
        if (trimmer && sampleRate !== undefined) {
          const { audio, trimSamples } = trimmer.finish(boundary?.end() ?? false);
          if (audio) {
            const played = play({ audio, sampleRate });
            chunks.push(played);
            void played.catch((error) => attempt.abort(error));
          }
          if (trimSamples) output.trimPlaybackTail?.(responseGeneration, id, trimSamples);
        }
        if (!result.played && !chunks.length && (!result.audio || !result.sampleRate))
          throw new Error("Speech service returned no audio.");
        if (!result.played && !chunks.length) {
          const played = play({ audio: result.audio!, sampleRate: result.sampleRate! });
          chunks.push(played);
        }
        // browserSpeech uses SpeechPlaybackController. Lane C can tag play's optional
        // fourth argument with {generation, speechId, onProgress}; stopPlayback(generation)
        // synchronously returns playedSamples/sampleRate and rejects late audio.
        const playback = Promise.all(chunks)
          .then(() => {
            audioSignal.throwIfAborted();
          })
          .finally(() => attempt.abort());
        void playback.catch(() => {});
        return { playback };
      } catch (error) {
        const playbackFailed = attempt.signal.aborted;
        attempt.abort();
        await Promise.allSettled(chunks);
        if (playbackFailed && !signal.aborted)
          throw new VoiceRequestError(
            "Audio playback failed. Check the audio device, then retry.",
            false,
          );
        throw error;
      }
    });
    if (!pipelined) await audio.playback;
    return audio;
  }
  async interrupt() {
    if (!this.active) return;
    this.filler.cancel();
    this.pendingFiller = undefined;
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
    this.filler.cancel();
    this.pendingFiller = undefined;
    this.playback.abort();
    this.watching.abort();
    this.stopRenewal();
    this.deps.audio.finish();
    this.deps.audio.close();
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
    this.filler.cancel();
    this.pendingFiller = undefined;
    this.stopRenewal();
    this.playback.abort();
    this.watching.abort();
    this.deps.audio.finish();
    this.deps.audio.close();
    this.queue = [];
    this.change("idle", "Call ended.");
    this.abort.abort();
    if (!this.saved) {
      return;
    }
    try {
      this.saved.closed = true;
      for (const recording of this.saved.recordings) delete recording.capturing;
      await this.persist();
      // Close has its own request so a stalled raw upload cannot keep the PC call open.
      const close = this.request({ action: "call.close" }, AbortSignal.timeout(15_000));
      await Promise.all([close, this.capture]);
      await this.flush(false, AbortSignal.timeout(30_000));
      if (this.saved?.typed?.length) {
        this.change("idle", "Call ended. Unsent words are saved for your next call.");
        return;
      }
      await this.deps.persistence.clear();
      this.saved = undefined;
      this.status = undefined;
      this.change("idle", "Call ended.");
    } catch {
      this.change(
        "idle",
        "Call ended. Saving queued speech and closing the PC session in the background.",
      );
      this.closeRetry.abort();
      this.closeRetry = new AbortController();
      void Effect.runPromise(Effect.sleep(5_000), { signal: this.closeRetry.signal })
        .then(() => this.stop())
        .catch(() => {});
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
  const delegated = /<otis-delegate>[\s\S]*?<\/otis-delegate>/.test(value);
  if (!value.trim() || (/<otis-hold\s*\/?[>\s]/.test(value) && !delegated)) return "";
  const text = value
    .replace(/<otis-hold\s*\/?\s*>/g, "")
    .replace(/<otis-(?:delegate|status)>[\s\S]*?(?:<\/otis-(?:delegate|status)>|$)/g, "")
    .replace(/<(?:o(?:t(?:i(?:s(?:-[a-z-]*)?)?)?)?)?$/g, "")
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
  return output.trim() || streaming || !value.trim() || delegated
    ? output
    : "I've put the details in the chat.";
}
