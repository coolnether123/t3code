import type { EnvironmentId, SpeechRequest } from "@t3tools/contracts";
import { createVoiceRequestCommand } from "@t3tools/client-runtime/voice-call/transport";
import * as Cause from "effect/Cause";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const speechRequest = createVoiceRequestCommand(connectionAtomRuntime);
export async function requestSpeech(
  environmentId: EnvironmentId,
  input: SpeechRequest,
  signal: AbortSignal,
) {
  const result = await speechRequest.run(appAtomRegistry, {
    environmentId,
    input: { request: input, signal },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** Owns microphone tracks and playback nodes for one visible voice session. */
export function createBrowserAudio() {
  let context: AudioContext | undefined;
  let finishCapture: (() => void) | undefined;
  let preparedStream: MediaStream | undefined;
  return {
    unlock() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access needs HTTPS or localhost.");
      }
      context ??= new AudioContext();
      void context.resume();
    },
    finish() {
      finishCapture?.();
    },
    async prepare(signal: AbortSignal) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        signal.throwIfAborted();
      }
      preparedStream?.getTracks().forEach((track) => track.stop());
      preparedStream = stream;
      await context!.resume();
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
            tone.stop();
            reject(signal.reason);
          };
          signal.addEventListener("abort", cancel, { once: true });
          tone.addEventListener("ended", () => resolve(), { once: true });
          tone.start();
          tone.stop(audio.currentTime + 0.22);
        });
      } finally {
        signal.removeEventListener("abort", cancel!);
        tone.disconnect();
        gain.disconnect();
      }
    },
    close() {
      finishCapture = undefined;
      preparedStream?.getTracks().forEach((track) => track.stop());
      preparedStream = undefined;
      void context?.close();
      context = undefined;
    },
    async capture(
      signal: AbortSignal,
      journal?: (audio: { audio: string; sampleRate: number }) => Promise<void>,
    ): Promise<{ audio: string; sampleRate: number }> {
      const audioContext = context!;
      const stream =
        preparedStream ??
        (await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        }));
      if (signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        signal.throwIfAborted();
      }
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const mute = audioContext.createGain();
      mute.gain.value = 0;
      const chunks: Float32Array[] = [];
      let length = 0;
      let speechSeen = false;
      let silenceSamples = 0;
      let journalTask: Promise<void> | undefined;
      let journalLength = 0;
      const recording = () => {
        const bytes = new Uint8Array(length * 2);
        const view = new DataView(bytes.buffer);
        let index = 0;
        for (const chunk of chunks)
          for (const sample of chunk) {
            const clipped = Math.max(-1, Math.min(1, sample));
            view.setInt16(index, clipped * (clipped < 0 ? 32768 : 32767), true);
            index += 2;
          }
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return { audio: btoa(binary), sampleRate: audioContext.sampleRate };
      };
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new DOMException("Cancelled", "AbortError"));
          signal.addEventListener("abort", abort, { once: true });
          finishCapture = () => {
            signal.removeEventListener("abort", abort);
            resolve();
          };
          processor.onaudioprocess = (event) => {
            const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
            chunks.push(chunk);
            length += chunk.length;
            if (journal && !journalTask && length - journalLength >= audioContext.sampleRate) {
              journalLength = length;
              journalTask = journal(recording())
                .catch(() => {
                  finishCapture?.();
                })
                .finally(() => {
                  journalTask = undefined;
                });
            }
            const rms = Math.sqrt(
              chunk.reduce((sum, sample) => sum + sample * sample, 0) / chunk.length,
            );
            if (rms > 0.015) {
              speechSeen = true;
              silenceSamples = 0;
            } else silenceSamples += chunk.length;
            if (speechSeen && silenceSamples > audioContext.sampleRate * 0.9) finishCapture?.();
            if (length >= audioContext.sampleRate * 59) finishCapture?.();
          };
          source.connect(processor);
          processor.connect(mute);
          mute.connect(audioContext.destination);
        });
        await journalTask;
        signal.throwIfAborted();
        return recording();
      } finally {
        finishCapture = undefined;
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
        mute.disconnect();
        if (stream !== preparedStream) stream.getTracks().forEach((track) => track.stop());
      }
    },
    async play(audio: string, sampleRate: number, signal: AbortSignal) {
      signal.throwIfAborted();
      const audioContext = context!;
      const binary = atob(audio);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const view = new DataView(bytes.buffer);
      const buffer = audioContext.createBuffer(1, bytes.length / 2, sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          source.stop();
          reject(new DOMException("Cancelled", "AbortError"));
        };
        signal.addEventListener("abort", abort, { once: true });
        source.addEventListener(
          "ended",
          () => {
            signal.removeEventListener("abort", abort);
            source.disconnect();
            resolve();
          },
          { once: true },
        );
        source.start();
      });
    },
  };
}
