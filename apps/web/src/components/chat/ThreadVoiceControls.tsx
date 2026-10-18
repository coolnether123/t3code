import { useLayoutEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import type { CallStatus, EnvironmentId, ModelSelection } from "@t3tools/contracts";
import type { Thread } from "../../types";
import { createBrowserAudio, requestSpeech } from "../../voice/browserSpeech";
import { callPersistence } from "../../voice/callPersistence";
import { ThreadVoiceSession, type VoiceState } from "../../voice/session";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";

export interface ThreadVoiceHandle {
  stop(): void;
}
const labels: Record<VoiceState, string> = {
  idle: "Call Otis",
  preparing: "Preparing",
  listening: "Listening",
  saving: "Saving on PC",
  transcribing: "Transcribing",
  waiting: "Waiting for the chat",
  speaking: "Speaking",
  ready: "Ready",
  reconnecting: "Connection interrupted",
  error: "Call needs attention",
};

export function ThreadVoiceControls({
  ref,
  ...props
}: {
  ref: Ref<ThreadVoiceHandle>;
  thread: Thread;
  environmentId: EnvironmentId;
  modelSelection: ModelSelection;
  enabled: boolean;
  running: boolean;
  connected: boolean;
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [detail, setDetail] = useState<string>();
  const [call, setCall] = useState<CallStatus>();
  const [expanded, setExpanded] = useState(false);
  const sessionRef = useRef<ThreadVoiceSession | null>(null);
  useLayoutEffect(() => {
    const session = new ThreadVoiceSession({
      speechEvent: (event) =>
        window.dispatchEvent(new CustomEvent("t3-voice-speech", { detail: event })),
      request: (input, signal, onAudio) =>
        requestSpeech(props.environmentId, input, signal, onAudio),
      audio: createBrowserAudio(),
      id: randomUUID,
      persistence: callPersistence(`${props.environmentId}:${props.thread.id}`),
      change: (next, message, status) => {
        setState(next);
        setDetail(message);
        setCall(status);
      },
    });
    sessionRef.current = session;
    const reconnect = () => {
      void session.resume();
    };
    window.addEventListener("online", reconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      void session.detach();
      sessionRef.current = null;
    };
  }, [props.environmentId, props.thread.id]);
  useImperativeHandle(
    ref,
    () => ({
      stop: () => {
        void sessionRef.current?.stop();
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    sessionRef.current?.observe(
      props.thread.messages,
      props.running,
      props.thread.latestTurn?.turnId,
      props.modelSelection,
    );
  }, [props.thread.messages, props.running, props.thread.latestTurn?.turnId, props.modelSelection]);
  const active = state !== "idle";
  const selection = props.modelSelection;
  return (
    <div className="relative" data-voice-state={state}>
      {!active ? (
        <Button type="button" size="sm" variant="outline" onClick={() => setExpanded(!expanded)}>
          Call Otis
        </Button>
      ) : null}
      {active || expanded || detail ? (
        <section
          aria-label="Otis call"
          className="absolute bottom-full right-0 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <p role="status" className="text-sm font-medium">
            {labels[state]}
          </p>
          <p className="mt-2 text-xs">
            {selection.model}
            {selection.options
              ?.map((option) => ` · ${option.id}: ${String(option.value)}`)
              .join("")}
          </p>
          {detail ? (
            <p
              role={state === "error" || state === "reconnecting" ? "alert" : undefined}
              className="mt-2 text-xs"
            >
              {detail}
            </p>
          ) : null}
          {!active ? (
            <div className="mt-3 grid gap-2 text-xs">
              <p>
                Uses this chat's model and permissions. Recordings save on this device, then on your
                PC before transcription. Ending the call leaves the chat working.
              </p>
              <Button
                type="button"
                size="sm"
                disabled={!props.enabled}
                onClick={() =>
                  void sessionRef.current?.start(
                    { threadId: props.thread.id, modelSelection: props.modelSelection },
                    props.thread.messages,
                  )
                }
              >
                Start call or recover saved call
              </Button>
            </div>
          ) : null}
          {state === "preparing" ? (
            <ul className="mt-2 space-y-1 text-xs">
              {call?.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          ) : null}
          {active ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {state === "listening" ? (
                <Button type="button" size="sm" onClick={() => sessionRef.current?.finish()}>
                  Send speech
                </Button>
              ) : null}
              {state === "speaking" || state === "waiting" ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void sessionRef.current?.interrupt()}
                >
                  Interrupt and speak
                </Button>
              ) : null}
              {state === "ready" ? (
                <Button type="button" size="sm" onClick={() => void sessionRef.current?.listen()}>
                  Speak
                </Button>
              ) : null}
              {state === "reconnecting" || state === "error" ? (
                <Button type="button" size="sm" onClick={() => void sessionRef.current?.resume()}>
                  Retry saved speech
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void sessionRef.current?.stop()}
              >
                End call
              </Button>
            </div>
          ) : null}
          {!props.connected && active ? (
            <p className="mt-2 text-xs">
              Chat connection lost. Speech saved only on this device stays queued until the PC
              acknowledges it.
            </p>
          ) : null}
        </section>
      ) : null}
      {active ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void sessionRef.current?.stop()}
        >
          End call
        </Button>
      ) : null}
    </div>
  );
}
