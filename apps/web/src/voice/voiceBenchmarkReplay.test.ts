// @effect-diagnostics nodeBuiltinImport:off - The offline replay fixture records observations synchronously at the test boundary.
import * as NodeFS from "node:fs";
import * as NodePerfHooks from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { shouldEndTurn } from "./turnEnding.ts";
import { createDeviceSpeech, type DeviceRecognition } from "./deviceSpeech.ts";
import { ThreadVoiceSession, type VoiceDependencies } from "@t3tools/client-runtime/voice-call";

type Fixture = {
  id: string;
  synthetic: boolean;
  trueEndS: number | null;
  explicitYield?: boolean;
  spans: number[][];
  segments: { startS: number; endS: number; whisper?: { text: string }; expectedText?: string }[];
};
const output = process.env.VOICE_BENCH_OUTPUT;
const manifest = process.env.VOICE_BENCH_MANIFEST;
const rows: object[] = [];
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.skipIf(!manifest)(
  "replays shipped PC policy and device recognition timers on fixed inputs",
  async () => {
    const fixtures: Fixture[] = JSON.parse(NodeFS.readFileSync(manifest!, "utf8")).fixtures;
    const custom = process.env.VOICE_BENCH_POLICY
      ? await import(process.env.VOICE_BENCH_POLICY)
      : undefined;
    const policy: typeof shouldEndTurn = custom?.shouldEndTurn ?? shouldEndTurn;
    for (const f of fixtures.filter((f) => f.synthetic)) {
      let speechMs = 0;
      for (let i = 0; i < f.spans.length; i++) {
        const [start, end] = f.spans[i]!;
        speechMs += (end! - start!) * 1000;
        let delayMs: number | null = null;
        for (let silenceMs = 0; silenceMs <= 10000; silenceMs += 10) {
          if (policy({ speechMs, lastBurstMs: (end! - start!) * 1000, silenceMs })) {
            delayMs = silenceMs;
            break;
          }
        }
        const next = f.spans[i + 1]?.[0];
        rows.push({
          kind: "turn",
          mode: "pc",
          fixture: f.id,
          pauseIndex: i,
          withinTurn: next !== undefined,
          falseCutoff: next !== undefined && delayMs !== null && end! + delayMs / 1000 < next,
          delayMs: next === undefined ? delayMs : null,
          explicitYield: f.explicitYield,
        });
      }
      if (custom?.replayDevice) {
        rows.push(...(await custom.replayDevice(f)));
        continue;
      }
      // Each opportunity runs separately so one early cutoff cannot hide later
      // opportunities. Final text is Whisper's segment text, delivered at the
      // labeled segment end. This is a recognition-arrival assumption, not Safari.
      for (let i = 0; i < f.segments.length; i++) {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const recognitions: DeviceRecognition[] = [];
        class Recognition implements DeviceRecognition {
          continuous = false;
          interimResults = false;
          lang = "";
          onresult: DeviceRecognition["onresult"] = null;
          onend: DeviceRecognition["onend"] = null;
          onerror: DeviceRecognition["onerror"] = null;
          onspeechstart: DeviceRecognition["onspeechstart"] = null;
          constructor() {
            recognitions.push(this);
          }
          start() {}
          stop() {
            this.onend?.();
          }
          abort() {}
        }
        vi.stubGlobal("window", { SpeechRecognition: Recognition });
        const speech = createDeviceSpeech();
        const controller = new AbortController();
        let finished: number | undefined;
        const capture = speech.capture(controller.signal).then(() => {
          finished = vi.getMockedSystemTime()!.getTime();
        });
        const recognition = recognitions[0]!;
        const text = f.segments
          .slice(0, i + 1)
          .map((s) => s.whisper?.text ?? s.expectedText ?? "")
          .join(" ");
        recognition.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: text } }],
        });
        await vi.advanceTimersByTimeAsync(10000);
        const next = f.segments[i + 1];
        rows.push({
          kind: "turn",
          mode: "device",
          fixture: f.id,
          pauseIndex: i,
          withinTurn: !!next,
          falseCutoff:
            !!next &&
            finished !== undefined &&
            finished < (next.startS - f.segments[i]!.endS) * 1000,
          delayMs: !next ? (finished ?? null) : null,
          explicitYield: f.explicitYield,
          recognitionArrivalLagMs: 0,
          transcriptSource: f.segments[i]!.whisper ? "Whisper" : "oracle, STT unavailable",
        });
        controller.abort();
        await capture;
        vi.useRealTimers();
      }
    }
    expect(rows.length).toBeGreaterThan(0);
  },
);

it.skipIf(!output)(
  "measures explicit interruption using the shipped session and fake audio IO",
  async () => {
    for (let run = 0; run < 20; run++) {
      let sequence = 0;
      let capture = deferred<{ audio: string; sampleRate: number }>();
      const waiting = deferred<void>();
      const playing = deferred<void>();
      const generated = deferred<void>();
      let send: ((chunk: { audio: string; sampleRate: number }) => void) | undefined;
      let stopped = 0,
        plays = 0,
        requests = 0;
      const deps: VoiceDependencies = {
        id: () => `bench-${++sequence}`,
        persistence: { read: async () => undefined, write: async () => {}, clear: async () => {} },
        change: (state) => {
          if (state === "waiting") waiting.resolve();
        },
        audio: {
          unlock() {},
          prepare: async () => {},
          ready: async () => {},
          close() {},
          finish() {
            capture.resolve({ audio: "AAA=", sampleRate: 16000 });
            capture = deferred();
          },
          finishAtPause() {},
          capture: () => capture.promise,
          play: async (_audio, _rate, signal) => {
            plays++;
            playing.resolve();
            await new Promise<void>((resolve) =>
              signal.addEventListener(
                "abort",
                () => {
                  stopped = NodePerfHooks.performance.now();
                  resolve();
                },
                { once: true },
              ),
            );
          },
        },
        request: async (input, signal, onAudio) => {
          if (input.action === "call.watch")
            return new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          if (input.action === "call.transcribe") return { text: "Go" };
          if (input.action === "call.deliver")
            return {
              utterance: {
                id: "bench-utterance",
                sha256: "fixture",
                bytes: 2,
                sampleRate: 16000,
                startedAt: "",
                endedAt: "",
                savedAt: "",
                text: "Go",
                deliveredAt: "now",
              },
            };
          if (input.action === "call.speak") {
            requests++;
            send = onAudio;
            onAudio!({ audio: "AAA=", sampleRate: 24000 });
            await generated.promise;
            return { complete: true };
          }
          return {};
        },
      };
      const session = new ThreadVoiceSession(deps);
      try {
        await session.start(
          {
            threadId: "bench",
            modelSelection: { instanceId: "claudeAgent", model: "bench" },
          } as Parameters<typeof session.start>[0],
          [],
        );
        session.finish();
        await waiting.promise;
        const message = {
          id: "reply",
          role: "assistant",
          text: "First. Second. Third.",
          streaming: true,
          turnId: "turn",
        };
        session.observe([message], true, "turn");
        await playing.promise;
        const before = plays,
          start = NodePerfHooks.performance.now();
        const interrupt = session.interrupt();
        let rejected = 0;
        for (let i = 0; i < 5; i++) {
          try {
            send!({ audio: "AAA=", sampleRate: 24000 });
          } catch {
            rejected++;
          }
        }
        generated.resolve();
        await interrupt;
        session.observe(
          [{ ...message, text: "First. Second. Third. Late.", streaming: false }],
          false,
          "turn",
        );
        rows.push({
          kind: "interrupt",
          run,
          silenceMs: stopped - start,
          stalePlayed: plays - before,
          staleRejected: rejected,
          queuedRequestsAfterInterrupt: requests - 1,
          scope: "Explicit interrupt; synchronous fake audio abort, excludes device output tail",
        });
        expect(rejected).toBe(5);
        expect(plays - before).toBe(0);
        expect(requests).toBe(1);
      } finally {
        generated.resolve();
        await session.detach();
      }
    }
  },
);

it.skipIf(!output)("saves replay observations", () => {
  NodeFS.writeFileSync(output!, JSON.stringify(rows, null, 2));
});
