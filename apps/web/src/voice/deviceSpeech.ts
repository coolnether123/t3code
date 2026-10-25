/* oxlint-disable unicorn/prefer-add-event-listener -- Each recognizer has one owner; cleanup clears its callback slots before abort. */
import { FloorController, type TranscriptRevision } from "@t3tools/client-runtime/voice-call/floor";

export interface RecognitionHooks {
  floor?: FloorController;
  transcript?(value: TranscriptRevision): boolean | void;
  activity?(voicedMs: number): void;
}

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
    capture(signal: AbortSignal, hooks?: RecognitionHooks): Promise<string | null> {
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
        let revision = 0;
        let speechStartedAt: number | undefined;
        const floor = hooks?.floor ?? new FloorController();
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
          floor.manual();
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
          const segments = new Map<number, { text: string; final: boolean }>();
          const prefix = text;
          recognition = current;
          current.continuous = true;
          current.interimResults = true;
          current.lang = "en-US";
          current.onspeechstart = () => {
            clearTimeout(quiet);
            interim = true;
            speechStartedAt = performance.now();
            floor.activity(speechStartedAt);
            hooks?.activity?.(0);
          };
          current.onresult = (event) => {
            if (settled || recognition !== current) return;
            interim = false;
            let changed = false;
            for (let index = event.resultIndex; index < event.results.length; index++) {
              const result = event.results[index]!;
              if (received.has(index)) continue;
              const previous = segments.get(index);
              changed ||=
                previous?.text !== result[0].transcript.trim() ||
                previous?.final !== result.isFinal;
              segments.set(index, { text: result[0].transcript.trim(), final: result.isFinal });
              if (result.isFinal) received.add(index);
            }
            if (!changed) return;
            const ordered = [...segments.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, value]) => value);
            interim = ordered.some((value) => !value.final);
            text = [prefix, ...ordered.map((value) => value.text)].filter(Boolean).join(" ").trim();
            const value = { text, revision: ++revision, final: !interim };
            hooks?.activity?.(
              speechStartedAt === undefined ? 0 : Math.max(0, performance.now() - speechStartedAt),
            );
            const accepted = hooks?.transcript?.(value) !== false;
            clearTimeout(quiet);
            if (!accepted) {
              text = prefix;
              segments.clear();
              return;
            }
            if (ending) return;
            floor.update(value, performance.now());
            const deadline = floor.commitAt;
            if (deadline !== undefined)
              quiet = setTimeout(
                () => {
                  if (floor.tick(performance.now())) finish?.();
                },
                Math.max(0, deadline - performance.now()),
              );
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
