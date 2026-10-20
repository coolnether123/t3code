/* oxlint-disable unicorn/prefer-add-event-listener -- Each recognizer has one owner; cleanup clears its callback slots before abort. */
import { shouldEndTurn } from "./turnEnding";

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
export interface DeviceRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onspeechstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => DeviceRecognition;

/** One utterance may span several of Safari's automatically ended recognition sessions. */
export function createDeviceSpeech() {
  let finish: (() => void) | undefined;
  let cancel: (() => void) | undefined;
  let pause: (() => void) | undefined;
  return {
    finish() {
      finish?.();
    },
    finishAtPause() {
      pause?.();
    },
    close() {
      cancel?.();
    },
    capture(signal: AbortSignal): Promise<string | null> {
      const browser = window as unknown as {
        SpeechRecognition?: RecognitionConstructor;
        webkitSpeechRecognition?: RecognitionConstructor;
      };
      const Recognition = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
      if (!Recognition) return Promise.resolve(null);
      return new Promise((resolve) => {
        let recognition: DeviceRecognition | undefined;
        let quiet: ReturnType<typeof setTimeout> | undefined;
        let restart: ReturnType<typeof setTimeout> | undefined;
        let text = "";
        let ending = false;
        let settled = false;
        let interim = false;
        const done = (value: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(quiet);
          clearTimeout(restart);
          signal.removeEventListener("abort", abort);
          if (recognition) {
            recognition.onresult = null;
            recognition.onend = null;
            recognition.onerror = null;
            recognition.onspeechstart = null;
            recognition.abort();
          }
          finish = undefined;
          cancel = undefined;
          pause = undefined;
          resolve(value);
        };
        const abort = () => done(text.trim());
        finish = () => {
          ending = true;
          clearTimeout(restart);
          if (recognition) recognition.stop();
          else done(text.trim());
        };
        cancel = abort;
        pause = () => {
          if (!text.trim() && !interim) finish?.();
        };
        const start = () => {
          if (settled || ending || signal.aborted) return;
          const current = new Recognition();
          const received = new Set<number>();
          recognition = current;
          current.continuous = true;
          current.interimResults = true;
          current.lang = "en-US";
          current.onspeechstart = () => {
            clearTimeout(quiet);
            interim = true;
          };
          current.onresult = (event) => {
            if (settled || recognition !== current) return;
            let changed = false;
            interim = false;
            for (let index = event.resultIndex; index < event.results.length; index++) {
              const result = event.results[index]!;
              if (!result.isFinal) {
                interim = true;
                continue;
              }
              if (received.has(index)) continue;
              received.add(index);
              text += ` ${result[0].transcript.trim()}`;
              changed = true;
            }
            if (ending || (!changed && !interim)) return;
            clearTimeout(quiet);
            if (interim || !text.trim()) return;
            const delay = shouldEndTurn({
              speechMs: 1500,
              lastBurstMs: 500,
              silenceMs: 1050,
              transcript: text,
            })
              ? 1050
              : 1850;
            quiet = setTimeout(() => finish?.(), delay);
          };
          current.onerror = (event) => {
            if (event.error !== "no-speech" && event.error !== "aborted") done(null);
          };
          current.onend = () => {
            if (recognition !== current || settled) return;
            recognition = undefined;
            if (ending) done(text.trim());
            else restart = setTimeout(start, 250);
          };
          try {
            current.start();
          } catch {
            done(null);
          }
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else start();
      });
    },
  };
}
