import { useEffect, useLayoutEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import type {
  CallModels,
  CallStatus,
  EnvironmentId,
  ModelSelection,
  OperatorUpdate,
} from "@t3tools/contracts";
import type { Thread } from "../../types";
import { createBrowserAudio, requestSpeech } from "../../voice/browserSpeech";
import { callPersistence } from "../../voice/callPersistence";
import { ThreadVoiceSession, type VoiceState } from "../../voice/session";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { CallModelSelectors, type CallSelectorCatalog } from "./CallModelSelectors";
import { initialCallModels } from "../../voice/modelDefaults";

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
}: CallSelectorCatalog & {
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
  const [models, setModels] = useState<CallModels>(() =>
    initialCallModels(
      props.instanceEntries.map((entry) => entry.snapshot),
      props.modelSelection,
    ),
  );
  const [configurationError, setConfigurationError] = useState<string>();
  const [configurationReady, setConfigurationReady] = useState(false);
  const [updates, setUpdates] = useState<readonly OperatorUpdate[]>([]);
  const configurationVersion = useRef(0);
  const configurationTail = useRef<Promise<unknown>>(Promise.resolve());
  const lastOperatorActivity = props.thread.activities.findLast((activity) =>
    activity.kind.startsWith("call.operator."),
  )?.id;
  const sessionRef = useRef<ThreadVoiceSession | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const version = configurationVersion.current;
    void requestSpeech(
      props.environmentId,
      {
        action: "call.configure",
        callId: "settings",
        options: { threadId: props.thread.id, modelSelection: props.modelSelection },
      },
      abort.signal,
    )
      .then((response) => {
        if (abort.signal.aborted) return;
        if (response.models && version === configurationVersion.current) setModels(response.models);
        setUpdates(response.operatorUpdates ?? []);
        if (version === configurationVersion.current) setConfigurationReady(true);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setConfigurationError(
            error instanceof Error ? error.message : "Call settings could not be loaded.",
          );
      });
    return () => abort.abort();
  }, [props.environmentId, props.thread.id, lastOperatorActivity]);
  useEffect(() => {
    if (call?.operatorUpdates) setUpdates(call.operatorUpdates);
  }, [call?.operatorUpdates]);
  const configure = async (next: CallModels, saveDefault = false) => {
    const version = ++configurationVersion.current;
    setModels(next);
    setConfigurationReady(false);
    try {
      const task = configurationTail.current
        .catch(() => {})
        .then(() =>
          requestSpeech(
            props.environmentId,
            {
              action: "call.configure",
              callId: "settings",
              options: {
                threadId: props.thread.id,
                modelSelection: next.voice,
                operatorSelection: next.operator,
              },
              saveDefault,
            },
            new AbortController().signal,
          ),
        );
      configurationTail.current = task;
      await task;
      if (version === configurationVersion.current) {
        setConfigurationError(undefined);
        setConfigurationReady(true);
      }
    } catch (error) {
      if (version === configurationVersion.current)
        setConfigurationError(
          error instanceof Error ? error.message : "Call settings could not be saved.",
        );
    }
  };
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
      models.voice,
      models.operator,
    );
  }, [props.thread.messages, props.running, props.thread.latestTurn?.turnId, models]);
  const active = state !== "idle";
  const selection = models.voice;
  const unheard = updates.filter(
    (update) => !update.heardAt && (update.status === "done" || update.status === "needs-Jared"),
  );
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
          className="absolute bottom-full right-0 mb-2 max-h-[70dvh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <p role="status" className="text-sm font-medium">
            {labels[state]}
          </p>
          <CallModelSelectors
            models={models}
            instanceEntries={props.instanceEntries}
            modelOptionsByInstance={props.modelOptionsByInstance}
            onChange={(next) => void configure(next)}
            disabled={!configurationReady && !configurationError}
          />
          <p className="mt-1 text-xs">Changes apply to the next turn.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!configurationReady}
            onClick={() => void configure(models, true)}
          >
            Use these models by default
          </Button>
          {configurationError ? (
            <p role="alert" className="mt-2 text-xs">
              {configurationError}
            </p>
          ) : null}
          {unheard.length ? (
            <details className="mt-2 text-xs">
              <summary>Unheard updates ({unheard.length})</summary>
              <ul>
                {unheard.map((update) => (
                  <li key={update.id} className="mt-1">
                    {update.text}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
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
                The voice model handles conversation while the background agent works with this
                chat's permissions. Recordings save on this device, then on your PC before
                transcription. Ending the call leaves the chat working.
              </p>
              <Button
                type="button"
                size="sm"
                disabled={!props.enabled || !configurationReady}
                onClick={() =>
                  void sessionRef.current?.start(
                    {
                      threadId: props.thread.id,
                      modelSelection: models.voice,
                      operatorSelection: models.operator,
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
