import { useEffect, useLayoutEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  CallModels,
  CallStatus,
  EnvironmentId,
  ModelSelection,
  OperatorUpdate,
  ThreadId,
} from "@t3tools/contracts";
import { useThreadProjection } from "../../state/entities";
import { createBrowserAudio, requestSpeech } from "../../voice/browserSpeech";
import { callPersistence } from "../../voice/callPersistence";
import { ThreadVoiceSession, type VoiceState } from "../../voice/session";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup } from "../ui/popover";
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
  threadId: ThreadId;
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
  const projection =
    useThreadProjection(scopeThreadRef(props.environmentId, props.threadId))?.projection ?? null;
  const messages = (projection?.messages ?? []).map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    streaming: message.streaming,
    turnId: message.runId,
  }));
  const latestTurnId = projection?.runs.at(-1)?.id ?? null;
  // The operator announces finished background work with a `voice-update:` message, so a new one
  // means the saved operator updates changed.
  const lastOperatorActivity = messages.findLast((message) =>
    message.id.startsWith("voice-update:"),
  )?.id;
  const sessionRef = useRef<ThreadVoiceSession | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    const version = configurationVersion.current;
    void requestSpeech(
      props.environmentId,
      {
        action: "call.configure",
        callId: "settings",
        options: { threadId: props.threadId, modelSelection: props.modelSelection },
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
  }, [props.environmentId, props.threadId, lastOperatorActivity]);
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
                threadId: props.threadId,
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
      persistence: callPersistence(`${props.environmentId}:${props.threadId}`),
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
  }, [props.environmentId, props.threadId]);
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
      messages,
      props.running,
      latestTurnId,
      models.voice,
      models.operator,
    );
  }, [messages, props.running, latestTurnId, models]);
  const active = state !== "idle";
  const selection = models.voice;
  const unheard = updates.filter(
    (update) => !update.heardAt && (update.status === "done" || update.status === "needs-Jared"),
  );
  return (
    <Popover open={active || expanded || !!detail} onOpenChange={setExpanded}>
      <div ref={anchorRef} className="relative" data-voice-state={state}>
        {!active ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setExpanded(!expanded)}>
            Call Otis
          </Button>
        ) : null}
        {active || expanded || detail ? (
          <PopoverPopup
            aria-label="Otis call controls"
            anchor={anchorRef}
            side="top"
            align="end"
            sideOffset={8}
            initialFocus={false}
            finalFocus={false}
            className="w-80 max-w-[calc(100dvw-1.5rem)] overflow-hidden rounded-xl border bg-popover"
            viewportClassName="flex max-h-[min(var(--available-height),calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-1.5rem))] min-h-0 flex-col overflow-hidden p-0 not-data-transitioning:overflow-hidden"
          >
            <section
              aria-label="Otis call"
              className="flex max-h-[inherit] min-h-0 flex-col text-popover-foreground"
            >
              <p role="status" className="shrink-0 px-3 pt-3 pb-2 text-sm font-medium">
                {labels[state]}
              </p>
              <div
                data-slot="call-panel-scroll"
                className="min-h-0 overflow-y-auto overscroll-contain px-3 pb-3 wrap-anywhere"
              >
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
                  <div className="mt-3 text-xs">
                    <p>
                      The voice model handles conversation while the background agent works with
                      this chat's permissions. Recordings save on this device, then on your PC
                      before transcription. Ending the call leaves the chat working.
                    </p>
                  </div>
                ) : null}
                {state === "preparing" ? (
                  <ul className="mt-2 space-y-1 text-xs">
                    {call?.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                ) : null}
                {!props.connected && active ? (
                  <p className="mt-2 text-xs">
                    Chat connection lost. Speech saved only on this device stays queued until the PC
                    acknowledges it.
                  </p>
                ) : null}
              </div>
              <div
                data-slot="call-panel-actions"
                className="flex shrink-0 flex-wrap gap-2 border-t p-3"
              >
                {!active ? (
                  <Button
                    type="button"
                    size="sm"
                    className="h-auto min-h-8 w-full whitespace-normal"
                    disabled={!props.enabled || !configurationReady}
                    onClick={() =>
                      void sessionRef.current?.start(
                        {
                          threadId: props.threadId,
                          modelSelection: models.voice,
                          operatorSelection: models.operator,
                        },
                        messages,
                      )
                    }
                  >
                    Start call or recover saved call
                  </Button>
                ) : null}
                {active ? (
                  <>
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
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void sessionRef.current?.listen()}
                      >
                        Speak
                      </Button>
                    ) : null}
                    {state === "reconnecting" || state === "error" ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void sessionRef.current?.resume()}
                      >
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
                  </>
                ) : null}
              </div>
            </section>
          </PopoverPopup>
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
    </Popover>
  );
}
