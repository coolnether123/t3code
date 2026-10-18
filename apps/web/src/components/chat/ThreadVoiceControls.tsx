import { useLayoutEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import type { CallPolicy, CallStatus, ModelSelection } from "@t3tools/contracts";
import type { Thread } from "../../types";
import { createBrowserAudio, requestSpeech } from "../../voice/browserSpeech";
import { callPersistence } from "../../voice/callPersistence";
import { ThreadVoiceSession, type VoiceState } from "../../voice/session";
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
  waiting: "Otis is thinking",
  speaking: "Otis is speaking",
  ready: "Ready",
  reconnecting: "Connection interrupted",
  error: "Call needs attention",
};

export function ThreadVoiceControls(props: {
  ref: Ref<ThreadVoiceHandle>;
  thread: Thread;
  environmentId: string;
  modelSelection: ModelSelection;
  enabled: boolean;
  running: boolean;
  connected: boolean;
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [detail, setDetail] = useState<string>();
  const [call, setCall] = useState<CallStatus>();
  const [expanded, setExpanded] = useState(false);
  const [model, setModel] = useState("claude-haiku-5-5");
  const [effort, setEffort] = useState("medium");
  const [policy, setPolicy] = useState<CallPolicy>("confirm-actions");
  const sessionRef = useRef<ThreadVoiceSession | null>(null);
  useLayoutEffect(() => {
    const session = new ThreadVoiceSession({
      request: requestSpeech,
      audio: createBrowserAudio(),
      id: () => crypto.randomUUID(),
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
      void session.stop();
      sessionRef.current = null;
    };
  }, [props.environmentId, props.thread.id]);
  useImperativeHandle(
    props.ref,
    () => ({
      stop: () => {
        void sessionRef.current?.stop();
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    sessionRef.current?.observe(props.thread.messages, props.running);
  }, [props.thread.messages, props.running]);
  const active = !["idle", "error"].includes(state);
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
              <label>
                Claude model
                <input
                  aria-label="Call model"
                  className="mt-1 w-full rounded border bg-background p-2"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
              </label>
              <label>
                Thinking
                <select
                  aria-label="Call thinking"
                  className="ml-2 rounded border bg-background p-1"
                  value={effort}
                  onChange={(event) => setEffort(event.target.value)}
                >
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                  <option value="high">High</option>
                  <option value="">Model default</option>
                </select>
              </label>
              <label>
                Confirm commands
                <select
                  aria-label="Call confirmation policy"
                  className="mt-1 w-full rounded border bg-background p-1"
                  value={policy}
                  onChange={(event) => setPolicy(event.target.value as CallPolicy)}
                >
                  <option value="confirm-actions">Actions, with reads immediate</option>
                  <option value="confirm-all">Every tool</option>
                  <option value="off">Use ordinary chat permissions</option>
                </select>
              </label>
              <p>
                Audio and transcripts stay saved on your PC. The selected Claude provider handles
                the chat. An unavailable model will show an error.
              </p>
              <Button
                type="button"
                size="sm"
                disabled={!props.enabled}
                onClick={() =>
                  void sessionRef.current?.start(
                    {
                      threadId: props.thread.id,
                      modelSelection: {
                        ...props.modelSelection,
                        model: model.trim(),
                        options: effort ? [{ id: "effort", value: effort }] : [],
                      },
                      policy,
                    },
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
                <li key={step}>✓ {step}</li>
              ))}
            </ul>
          ) : null}
          {call?.pending[0] ? (
            <div className="mt-2 rounded border p-2 text-xs">
              <p>{call.pending[0].summary}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void sessionRef.current?.confirm("yes")}
                >
                  Yes, run it
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void sessionRef.current?.confirm("no")}
                >
                  No
                </Button>
              </div>
            </div>
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
              {state === "reconnecting" ? (
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
              Chat connection lost. Keep this page open; recorded speech stays queued.
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
