import { SpeechResponse, type SpeechRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

const decodeSpeechResponse = Schema.decodeUnknownSync(SpeechResponse);

export async function requestSpeech(input: SpeechRequest, signal: AbortSignal) {
  const url = resolvePrimaryEnvironmentHttpUrl("/api/voice");
  const sameOrigin = new URL(url).origin === window.location.origin && !window.desktopBridge;
  const token = sameOrigin ? null : await readDesktopPrimaryBearerToken();
  signal.throwIfAborted();
  const response = await fetch(url, {
    method: "POST",
    credentials: sameOrigin ? "include" : "omit",
    signal,
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "This server needs the voice integration update."
        : `Local speech unavailable (${response.status}).`,
    );
  return decodeSpeechResponse(await response.json());
}

/** Owns microphone tracks and playback nodes for one visible voice session. */
export function createBrowserAudio() {
  let context: AudioContext | undefined;
  let finishCapture: (() => void) | undefined;
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
    close() {
      finishCapture = undefined;
      void context?.close();
      context = undefined;
    },
    async capture(signal: AbortSignal): Promise<{ audio: string; sampleRate: number }> {
      const audioContext = context!;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
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
            if (length >= audioContext.sampleRate * 59) finishCapture?.();
          };
          source.connect(processor);
          processor.connect(mute);
          mute.connect(audioContext.destination);
        });
        signal.throwIfAborted();
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
      } finally {
        finishCapture = undefined;
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
        mute.disconnect();
        stream.getTracks().forEach((track) => track.stop());
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
