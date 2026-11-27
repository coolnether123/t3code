import {
  OTIS_THREAD_ID,
  ProviderInstanceId,
  type CallStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { randomUUID } from "~/lib/utils";
import { createBrowserAudio, requestSpeech } from "~/voice/browserSpeech";
import { callPersistence } from "~/voice/callPersistence";
import { callStatusLabel } from "~/voice/callStatus";
import { ThreadVoiceSession, type VoiceState } from "~/voice/session";

const modelSelection = { instanceId: ProviderInstanceId.make("otis-front"), model: "otis-front" };

export function useFrontCall(environmentId: EnvironmentId) {
  const session = useRef<ThreadVoiceSession | null>(null);
  const audio = useRef<ReturnType<typeof createBrowserAudio> | null>(null);
  const [state, setState] = useState<VoiceState>("idle");
  const [call, setCall] = useState<CallStatus>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the microphone and preserve its archived call across socket reconnects.
  useLayoutEffect(() => {
    const browserAudio = createBrowserAudio(() => voice.audioInterrupted());
    const voice = new ThreadVoiceSession({
      audio: browserAudio,
      id: randomUUID,
      request: (input, signal, onAudio) => requestSpeech(environmentId, input, signal, onAudio),
      persistence: callPersistence(`${environmentId}:${OTIS_THREAD_ID}`),
      change: (next, _message, status) => {
        setState(next);
        setCall(status);
      },
    });
    session.current = voice;
    audio.current = browserAudio;
    const reconnect = () => void voice.resume(false);
    window.addEventListener("online", reconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      void voice.detach();
      session.current = null;
      audio.current = null;
    };
  }, [environmentId]);
  return { session, audio, state, call };
}

export type FrontCall = ReturnType<typeof useFrontCall>;

export function CallBar({ voice }: { voice: FrontCall }) {
  const gt = useGT();
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(true);
  const [seconds, setSeconds] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Show elapsed time while this call bar is mounted.
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <div className="flex flex-wrap items-center gap-x-2 border-b border-border px-3 py-1 text-xs">
      {voice.state === "error" ? (
        <>
          <span role="alert" className="min-w-0 flex-1 text-destructive">
            {gt("The call could not connect. Please try again.")}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void voice.session.current?.resume()}>
            {gt("Retry call")}
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 text-muted-foreground tabular-nums">
            {gt("On call · {elapsed} · {status}", {
              elapsed,
              status: callStatusLabel(voice.state, voice.call),
            })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMuted(!muted);
              void voice.session.current?.setMuted(!muted);
            }}
          >
            {muted ? gt("Unmute") : gt("Mute")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={speaker}
            onClick={() => {
              setSpeaker(!speaker);
              voice.audio.current?.setSpeaker(!speaker);
            }}
          >
            {speaker ? gt("Speaker on") : gt("Speaker off")}
          </Button>
        </>
      )}
      <span className="text-destructive">
        <Button variant="ghost" size="sm" onClick={() => void voice.session.current?.stop()}>
          {gt("End")}
        </Button>
      </span>
    </div>
  );
}

export function startFrontCall(voice: FrontCall) {
  voice.audio.current?.setSpeaker(true);
  return voice.session.current?.start({ threadId: OTIS_THREAD_ID, modelSelection }, []);
}
