import type { EnvironmentId, SpeechRequest } from "@t3tools/contracts";
import { createVoiceRequestCommand } from "@t3tools/client-runtime/voice-call/transport";
import {
  SpeechPlaybackController,
  type PlaybackMetadata,
} from "@t3tools/client-runtime/voice-call/playback";
import * as Cause from "effect/Cause";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { shouldEndTurn } from "./turnEnding";
import { createDeviceSpeech } from "./deviceSpeech";
import { FloorController, type TranscriptRevision } from "@t3tools/client-runtime/voice-call/floor";
import type { CaptureHooks } from "@t3tools/client-runtime/voice-call";

const speechRequest = createVoiceRequestCommand(connectionAtomRuntime);
export async function requestSpeech(
  environmentId: EnvironmentId,
  input: SpeechRequest,
  signal: AbortSignal,
  onAudio?: (chunk: { audio: string; sampleRate: number }) => void,
) {
  const result = await speechRequest.run(appAtomRegistry, {
    environmentId,
    input: { request: input, signal, ...(onAudio ? { onAudio } : {}) },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** Owns microphone tracks and playback nodes for one visible voice session. */
export function createBrowserAudio(onInterrupted?: () => void) {
  const deviceSpeech = createDeviceSpeech();
  let context: AudioContext | undefined;
  let finishCapture: (() => void) | undefined;
  let preparedStream: MediaStream | undefined;
  let playback: SpeechPlaybackController | undefined;
  let playbackGeneration = "legacy";
  let nextSpeech = 0;
  const speechIds = new WeakMap<AbortSignal, string>();
  let finishAtPause = false;
  let interrupted = false;
  let cancelReady: (() => void) | undefined;
  let reconnectCapture: ((stream: MediaStream) => void) | undefined;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  let recoveryDeadline: ReturnType<typeof setTimeout> | undefined;
  let microphoneDeadline: ReturnType<typeof setTimeout> | undefined;
  const clearRecovery = () => {
    clearInterval(recoveryTimer);
    clearTimeout(recoveryDeadline);
    recoveryTimer = undefined;
    recoveryDeadline = undefined;
  };
  const interrupt = () => {
    if (interrupted || !context) return;
    clearRecovery();
    clearTimeout(microphoneDeadline);
    microphoneDeadline = undefined;
    interrupted = true;
    cancelReady?.();
    finishCapture?.();
    onInterrupted?.();
  };
  const resumeContext = () => {
    const audio = context;
    if (!audio || interrupted) return;
    void audio
      .resume()
      .then(() => {
        if (context === audio && audio.state === "running") clearRecovery();
      })
      .catch(() => {});
  };
  const stateChanged = () => {
    if (!context || interrupted) return;
    if (context.state === "running") {
      clearRecovery();
      return;
    }
    if (context.state === "closed") {
      interrupt();
      return;
    }
    if (recoveryDeadline) return;
    recoveryTimer = setInterval(resumeContext, 500);
    recoveryDeadline = setTimeout(() => {
      if (context?.state === "running") clearRecovery();
      else interrupt();
    }, 3_000);
    resumeContext();
  };
  const foreground = () => {
    if (document.visibilityState === "visible") {
      stateChanged();
      if (recoveryDeadline) resumeContext();
    }
  };
  return {
    unlock() {
      if (!window.isSecureContext) {
        throw new Error("Microphone access needs HTTPS or localhost.");
      }
      if (interrupted || context?.state === "closed") this.close();
      if (!context) {
        context = new AudioContext();
        playback = new SpeechPlaybackController(context);
        playback.begin(playbackGeneration);
        context.addEventListener("statechange", stateChanged);
        document.addEventListener("visibilitychange", foreground);
        window.addEventListener("pageshow", foreground);
      }
      resumeContext();
      stateChanged();
    },
    finish() {
      deviceSpeech.finish();
      finishCapture?.();
    },
    finishAtPause() {
      deviceSpeech.finishAtPause();
      finishAtPause = true;
    },
    captureText: deviceSpeech.capture,
    async prepare(signal: AbortSignal, inputMode?: "pc" | "device") {
      if (inputMode === "device") {
        preparedStream?.getTracks().forEach((track) => track.stop());
        preparedStream = undefined;
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        signal.throwIfAborted();
      }
      preparedStream?.getTracks().forEach((track) => track.stop());
      preparedStream = stream;
      const audio = context!;
      let reacquired = false;
      const watch = (watched: MediaStream) => {
        for (const track of watched.getAudioTracks())
          track.addEventListener(
            "ended",
            () => {
              if (context !== audio || preparedStream !== watched || signal.aborted || interrupted)
                return;
              if (reacquired) {
                interrupt();
                return;
              }
              reacquired = true;
              microphoneDeadline = setTimeout(interrupt, 3_000);
              void navigator.mediaDevices
                .getUserMedia({
                  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
                })
                .then((replacement) => {
                  if (
                    context !== audio ||
                    preparedStream !== watched ||
                    signal.aborted ||
                    interrupted
                  ) {
                    replacement.getTracks().forEach((item) => item.stop());
                    return;
                  }
                  preparedStream = replacement;
                  clearTimeout(microphoneDeadline);
                  microphoneDeadline = undefined;
                  reconnectCapture?.(replacement);
                  watched.getTracks().forEach((item) => item.stop());
                  watch(replacement);
                  resumeContext();
                })
                .catch(() => {
                  if (context === audio && preparedStream === watched && !signal.aborted)
                    interrupt();
                });
            },
            { once: true },
          );
      };
      watch(stream);
      // iOS may pause the audio clock while getUserMedia changes the audio session.
      resumeContext();
      stateChanged();
    },
    async ready(signal: AbortSignal) {
      signal.throwIfAborted();
      const audio = context!;
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.frequency.value = 660;
      gain.gain.setValueAtTime(0.08, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.2);
      tone.connect(gain);
      gain.connect(audio.destination);
      let cancel: () => void;
      try {
        await new Promise<void>((resolve, reject) => {
          cancel = () => {
            reject(signal.reason ?? new DOMException("Audio was interrupted", "AbortError"));
            tone.stop();
          };
          cancelReady = cancel;
          signal.addEventListener("abort", cancel, { once: true });
          tone.addEventListener("ended", () => resolve(), { once: true });
          tone.start();
          tone.stop(audio.currentTime + 0.22);
        });
      } finally {
        signal.removeEventListener("abort", cancel!);
        cancelReady = undefined;
        tone.disconnect();
        gain.disconnect();
      }
    },
    close() {
      deviceSpeech.close();
      clearRecovery();
      clearTimeout(microphoneDeadline);
      microphoneDeadline = undefined;
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("pageshow", foreground);
      cancelReady?.();
      playback?.stop(playbackGeneration);
      playback = undefined;
      playbackGeneration = "legacy";
      finishCapture = undefined;
      interrupted = false;
      reconnectCapture = undefined;
      preparedStream?.getTracks().forEach((track) => track.stop());
      preparedStream = undefined;
      if (context) {
        context.removeEventListener("statechange", stateChanged);
        void context.close();
      }
      context = undefined;
    },
    async capture(
      signal: AbortSignal,
      journal?: (audio: { audio: string; sampleRate: number }) => Promise<void>,
      hooks?: CaptureHooks,
    ): Promise<{ audio: string; sampleRate: number; text?: string }> {
      const audioContext = context!;
      finishAtPause = false;
      let stream =
        preparedStream ??
        (await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        }));
      if (signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        signal.throwIfAborted();
      }
      let source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      reconnectCapture = (replacement) => {
        source.disconnect();
        stream = replacement;
        source = audioContext.createMediaStreamSource(stream);
        source.connect(processor);
      };
      const mute = audioContext.createGain();
      mute.gain.value = 0;
      const chunks: Float32Array[] = [];
      let length = 0;
      let speechSeen = false;
      let silenceSamples = 0;
      let speechSamples = 0;
      let burstSamples = 0;
      let lastBurstSamples = 0;
      let journalTask: Promise<void> | undefined;
      let journalLength = 0;
      let partialLength = 0;
      let partialTask: Promise<void> | undefined;
      let revision = 0;
      let resetPartial = false;
      let prefixText = "";
      let latestText = "";
      let speechEpoch = 0;
      const floor = hooks?.floor ?? new FloorController();
      const recording = (from = 0, until = length) => {
        const bytes = new Uint8Array((until - from) * 2);
        const view = new DataView(bytes.buffer);
        let index = 0;
        let sampleIndex = 0;
        for (const chunk of chunks)
          for (const sample of chunk) {
            const position = sampleIndex++;
            if (position < from || position >= until) continue;
            const clipped = Math.max(-1, Math.min(1, sample));
            view.setInt16(index, clipped * (clipped < 0 ? 32768 : 32767), true);
            index += 2;
          }
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 512)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 512));
        return { audio: btoa(binary), sampleRate: audioContext.sampleRate };
      };
      const recognize = async () => {
        if (!hooks?.partial || length <= partialLength) return;
        const sentLength = length;
        const epoch = speechEpoch;
        const partial = recording(partialLength);
        const reset = resetPartial;
        resetPartial = false;
        partialLength = sentLength;
        try {
          const value = await hooks.partial(partial, ++revision, reset);
          if (signal.aborted) return;
          const combined: TranscriptRevision = {
            ...value,
            text: [prefixText, value.text].filter(Boolean).join(" "),
            final: value.final && epoch === speechEpoch,
          };
          if (hooks.transcript?.(combined) === false) {
            chunks.length = 0;
            length = partialLength = journalLength = 0;
            speechSeen = false;
            latestText = "";
            resetPartial = true;
            floor.update(
              { text: prefixText, revision: value.revision, final: false },
              performance.now(),
            );
            return;
          }
          latestText = value.text;
          floor.update(combined, performance.now());
          if (epoch !== speechEpoch) floor.activity(performance.now());
          if (sentLength >= audioContext.sampleRate * 45 && hooks.segment) {
            await journalTask;
            await hooks.segment(recording(0, sentLength));
            let removed = 0;
            while (chunks.length && removed < sentLength) removed += chunks.shift()!.length;
            length -= removed;
            partialLength = journalLength = 0;
            prefixText = combined.text;
            latestText = "";
            resetPartial = true;
          }
        } catch {
          resetPartial = true;
          partialLength = 0;
        }
      };
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new DOMException("Cancelled", "AbortError"));
          signal.addEventListener("abort", abort, { once: true });
          finishCapture = () => {
            signal.removeEventListener("abort", abort);
            processor.onaudioprocess = null;
            resolve();
          };
          processor.onaudioprocess = (event) => {
            if (audioContext.state !== "running" || microphoneDeadline || interrupted) return;
            const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
            const rms = Math.sqrt(
              chunk.reduce((sum, sample) => sum + sample * sample, 0) / chunk.length,
            );
            if (rms > 0.015) {
              speechEpoch++;
              speechSeen = true;
              speechSamples += chunk.length;
              burstSamples += chunk.length;
              lastBurstSamples = burstSamples;
              silenceSamples = 0;
            } else {
              silenceSamples += chunk.length;
              burstSamples = 0;
            }
            // Retain speech and short pauses, without growing the recording during an idle call.
            if (speechSeen && silenceSamples <= audioContext.sampleRate * 2) {
              chunks.push(chunk);
              length += chunk.length;
            }
            if (journal && !journalTask && length - journalLength >= audioContext.sampleRate) {
              journalLength = length;
              journalTask = journal(recording()).finally(() => {
                journalTask = undefined;
              });
              void journalTask.catch(() => finishCapture?.());
            }
            if (rms > 0.015) {
              floor.activity(performance.now());
              hooks?.activity?.((burstSamples / audioContext.sampleRate) * 1000);
            }
            if (
              hooks?.partial &&
              !partialTask &&
              speechSeen &&
              length - partialLength >= audioContext.sampleRate * 0.75
            ) {
              partialTask = recognize().finally(() => {
                partialTask = undefined;
              });
            }
            if (
              floor.tick(performance.now()) ||
              shouldEndTurn({
                speechMs: (speechSamples / audioContext.sampleRate) * 1_000,
                lastBurstMs: (lastBurstSamples / audioContext.sampleRate) * 1_000,
                silenceMs: (silenceSamples / audioContext.sampleRate) * 1_000,
                finishAtPause,
              })
            )
              finishCapture?.();
            // Without a working partial recognizer, retain the bounded recording for manual Send.
            if (length >= audioContext.sampleRate * 59) {
              chunks.pop();
              length -= chunk.length;
            }
          };
          source.connect(processor);
          processor.connect(mute);
          mute.connect(audioContext.destination);
        });
        await journalTask;
        await partialTask;
        if (!signal.aborted) await recognize();
        // Finish captures the final buffer even when hang-up cancels network work immediately.
        return speechSeen || prefixText
          ? {
              ...recording(),
              ...([prefixText, latestText].filter(Boolean).length
                ? { text: [prefixText, latestText].filter(Boolean).join(" ") }
                : {}),
            }
          : { audio: "", sampleRate: audioContext.sampleRate };
      } finally {
        reconnectCapture = undefined;
        finishCapture = undefined;
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
        mute.disconnect();
        if (stream !== preparedStream) stream.getTracks().forEach((track) => track.stop());
      }
    },
    beginPlayback(generation: string) {
      playback!.begin(generation);
      playbackGeneration = generation;
    },
    stopPlayback(generation: string) {
      return playback?.stop(generation) ?? [];
    },
    playbackProgress(generation: string) {
      return playback?.progress(generation) ?? [];
    },
    emittingSpeech(generation: string) {
      return playback?.emitting(generation) ?? [];
    },
    cancelShortClips(generation: string) {
      playback?.cancelShortClips(generation);
    },
    async play(
      audio: string,
      sampleRate: number,
      signal: AbortSignal,
      metadata?: PlaybackMetadata,
    ) {
      let speechId = speechIds.get(signal);
      if (!speechId) {
        speechId = `clip-${++nextSpeech}`;
        speechIds.set(signal, speechId);
      }
      await playback!.play(
        audio,
        sampleRate,
        signal,
        metadata ?? {
          generation: playbackGeneration,
          speechId,
        },
      );
      signal.throwIfAborted();
    },
    async playShortClip(
      audio: string,
      sampleRate: number,
      signal: AbortSignal,
      metadata: PlaybackMetadata,
    ) {
      await playback!.play(audio, sampleRate, signal, { ...metadata, channel: "backchannel" });
      signal.throwIfAborted();
    },
  };
}
