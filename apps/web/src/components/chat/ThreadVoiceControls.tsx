import { useLayoutEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import type { Thread } from "../../types";
import { createBrowserAudio, requestSpeech } from "../../voice/browserSpeech";
import { ThreadVoiceSession, type VoiceState } from "../../voice/session";
import { Button } from "../ui/button";

export interface ThreadVoiceHandle {
  stop(): void;
}
const labels: Record<VoiceState, string> = {
  idle: "Start voice",
  starting: "Starting voice",
  listening: "Listening",
  transcribing: "Transcribing",
  waiting: "Waiting for reply",
  speaking: "Otis is speaking",
  ready: "Voice ready",
  error: "Voice unavailable",
};

export function ThreadVoiceControls({
  ref,
  ...props
}: {
  ref: Ref<ThreadVoiceHandle>;
  thread: Thread;
  enabled: boolean;
  cancel: boolean;
  running: boolean;
  submit(text: string): boolean;
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string>();
  const latest = useRef(props);
  const sessionRef = useRef<ThreadVoiceSession | null>(null);
  useLayoutEffect(() => {
    latest.current = props;
  });
  useLayoutEffect(() => {
    const session = new ThreadVoiceSession({
      request: requestSpeech,
      audio: createBrowserAudio(),
      submit: (text) => latest.current.enabled && latest.current.submit(text),
      change: (next, message) => {
        setState(next);
        setError(message);
      },
    });
    sessionRef.current = session;
    return () => {
      session.stop();
      sessionRef.current = null;
    };
  }, []);
  useImperativeHandle(ref, () => ({ stop: () => sessionRef.current?.stop() }), []);
  useLayoutEffect(() => {
    if (props.cancel || props.thread.latestTurn?.state === "interrupted")
      sessionRef.current?.stop();
    else sessionRef.current?.observe(props.thread.messages, props.thread.activities, props.running);
  }, [
    props.cancel,
    props.thread.messages,
    props.thread.activities,
    props.thread.latestTurn?.state,
    props.running,
  ]);
  const active = state !== "idle" && state !== "error";
  if (!active && !props.enabled && !error) return null;
  return (
    <div className="relative flex items-center gap-2" data-voice-state={state}>
      {active ? (
        <>
          <svg
            viewBox="0 0 40 40"
            className="size-8 shrink-0 text-message-action"
            role="img"
            aria-label="Otis"
          >
            <rect x="5" y="4" width="30" height="32" rx="10" fill="currentColor" opacity="0.16" />
            <g
              fill="currentColor"
              className="transition-transform duration-150 motion-reduce:transition-none"
              style={{ transform: state === "listening" ? "translateY(-1px)" : undefined }}
            >
              <circle cx="14" cy="16" r="2.5" />
              <circle cx="26" cy="16" r="2.5" />
              <rect x="14" y="25" width="12" height={state === "speaking" ? 6 : 2} rx="2" />
            </g>
          </svg>
          <span className="sr-only" role="status">
            {labels[state]}
          </span>
          {state === "listening" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => sessionRef.current?.finish()}
            >
              Send speech
            </Button>
          ) : state === "ready" && props.enabled ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void sessionRef.current?.listen()}
            >
              Speak
            </Button>
          ) : (
            <span className="max-w-24 text-xs text-muted-foreground">{labels[state]}</span>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => sessionRef.current?.stop()}
            aria-label="Stop voice"
          >
            Stop voice
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          className="rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover"
          disabled={!props.enabled}
          title="Use your microphone. Audio is transcribed by this environment's local speech service."
          onClick={() =>
            void sessionRef.current?.start(props.thread.messages, props.thread.activities)
          }
        >
          Start voice
        </Button>
      )}
      {error ? (
        <div
          role="alert"
          className="absolute bottom-full right-0 mb-2 w-64 rounded-lg border bg-popover p-3 text-xs text-popover-foreground"
        >
          {error}
          <Button type="button" size="sm" variant="ghost" onClick={() => setError(undefined)}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </div>
  );
}
