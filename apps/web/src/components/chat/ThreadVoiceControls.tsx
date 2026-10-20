import { useEffect, useLayoutEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import { MicIcon, SendIcon, Settings2Icon, SquareIcon, XIcon } from "lucide-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  CallModels,
  CallStatus,
  EnvironmentId,
  ModelSelection,
  CallOptions,
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
import { ComposerBanner } from "./ComposerBanner";

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
  reconnecting: "Reconnecting",
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
  defaultModelSelection?: ModelSelection | null;
  ensureThread(options: CallOptions): Promise<void>;
  isDraft: boolean;
  onActiveChange?: ((active: boolean) => void) | undefined;
  onPanelOpenChange?: ((open: boolean) => void) | undefined;
  defaultOpen?: boolean | undefined;
  enabled: boolean;
  running: boolean;
  connected: boolean;
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [detail, setDetail] = useState<string>();
  const [call, setCall] = useState<CallStatus>();
  const [expanded, setExpanded] = useState(props.defaultOpen ?? false);
  const [preferences, setModels] = useState<CallModels>(() =>
    initialCallModels(
      props.instanceEntries.map((entry) => entry.snapshot),
      props.modelSelection,
      props,
      props.defaultModelSelection,
    ),
  );
  const [savedDefaults, setSavedDefaults] = useState<CallModels>();
  const catalog = {
    instanceEntries: props.instanceEntries,
    modelOptionsByInstance: props.modelOptionsByInstance,
  };
  const models = initialCallModels(
    catalog.instanceEntries.map((entry) => entry.snapshot),
    props.modelSelection,
    catalog,
    props.defaultModelSelection,
    preferences,
    savedDefaults,
  );
  const callbacks = useRef(props);
  useLayoutEffect(() => {
    callbacks.current = props;
  });
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
  const voiceReply = messages.findLast((message) => message.id.startsWith("voice-reply:"));
  const voiceRunning = voiceReply?.streaming === true;
  const latestTurnId =
    (props.running
      ? projection?.runs.at(-1)?.id
      : (voiceReply?.turnId ?? projection?.runs.at(-1)?.id)) ?? null;
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
        const current = callbacks.current;
        setSavedDefaults(response.defaultModels);
        if (version === configurationVersion.current)
          setModels(
            initialCallModels(
              current.instanceEntries.map((entry) => entry.snapshot),
              current.modelSelection,
              current,
              current.defaultModelSelection,
              response.models,
              response.defaultModels,
            ),
          );
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
  }, [props.environmentId, props.threadId, props.modelSelection]);
  const configure = async (next: CallModels, saveDefault = false) => {
    const version = ++configurationVersion.current;
    setModels(next);
    if (props.isDraft && !saveDefault) {
      setConfigurationError(undefined);
      setConfigurationReady(true);
      return;
    }
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
      ensureThread: (options) => callbacks.current.ensureThread(options),
      speechEvent: (event) =>
        window.dispatchEvent(new CustomEvent("t3-voice-speech", { detail: event })),
      request: (input, signal, onAudio) =>
        requestSpeech(props.environmentId, input, signal, onAudio),
      audio: createBrowserAudio(() => session.audioInterrupted()),
      id: randomUUID,
      persistence: callPersistence(`${props.environmentId}:${props.threadId}`),
      change: (next, message, status) => {
        setState(next);
        setDetail(message);
        setCall(status);
        if (next === "idle" || next === "preparing" || next === "error") setExpanded(false);
        callbacks.current.onActiveChange?.(next !== "idle");
      },
    });
    sessionRef.current = session;
    const reconnect = () => {
      void session.resume(false);
    };
    window.addEventListener("online", reconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      void session.detach();
      callbacks.current.onActiveChange?.(false);
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
      props.running || voiceRunning,
      latestTurnId ?? undefined,
      models.voice,
      models.operator,
    );
  }, [messages, props.running, voiceRunning, latestTurnId, models]);
  const active = state !== "idle";
  const panelOpen = active || expanded;
  // Keep the session mounted when the phone composer blurs or an approval arrives.
  useEffect(() => {
    callbacks.current.onPanelOpenChange?.(panelOpen);
  }, [panelOpen]);
  useEffect(() => () => callbacks.current.onPanelOpenChange?.(false), []);
  const unheard = (call?.operatorUpdates ?? updates).filter(
    (update) => !update.heardAt && (update.status === "done" || update.status === "needs-Jared"),
  );
  return (
    <Popover open={expanded} onOpenChange={setExpanded}>
      <div ref={anchorRef} className="relative min-w-0 w-full" data-voice-state={state}>
        {active ? (
          <section aria-label="Otis call">
            <ComposerBanner.Root
              placement="floating"
              variant={state === "error" ? "error" : "default"}
            >
              <ComposerBanner.Row>
                <ComposerBanner.Content>
                  <span role="status" className="min-w-0 wrap-anywhere">
                    {labels[state]}
                  </span>
                </ComposerBanner.Content>
                <ComposerBanner.Actions>
                  {state === "listening" ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Send speech"
                      onClick={() => sessionRef.current?.finish()}
                    >
                      <SendIcon />
                    </Button>
                  ) : null}
                  {state === "speaking" || state === "waiting" ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Interrupt and speak"
                      onClick={() => void sessionRef.current?.interrupt()}
                    >
                      <SquareIcon />
                    </Button>
                  ) : null}
                  {state === "ready" ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Speak"
                      onClick={() => void sessionRef.current?.listen()}
                    >
                      <MicIcon />
                    </Button>
                  ) : null}
                  {state === "reconnecting" || state === "error" ? (
                    <Button
                      type="button"
                      size="compact"
                      variant="outline"
                      aria-label="Retry saved speech"
                      onClick={() => void sessionRef.current?.resume()}
                    >
                      Retry
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Call settings"
                    aria-expanded={expanded}
                    onClick={() => setExpanded(!expanded)}
                  >
                    <Settings2Icon />
                  </Button>
                  <Button
                    type="button"
                    size="compact"
                    variant="outline"
                    onClick={() => void sessionRef.current?.stop()}
                  >
                    End call
                  </Button>
                </ComposerBanner.Actions>
              </ComposerBanner.Row>
              {detail &&
              (state === "error" || state === "reconnecting" || state === "preparing") ? (
                <p
                  role={state === "preparing" ? undefined : "alert"}
                  className="px-2 pt-1 text-xs wrap-anywhere"
                >
                  {detail}
                </p>
              ) : null}
              {configurationError ? (
                <p role="alert" className="px-2 pt-1 text-xs wrap-anywhere">
                  {configurationError}
                </p>
              ) : null}
              {!props.connected ? (
                <p className="px-2 pt-1 text-xs wrap-anywhere">
                  Chat disconnected. Speech stays queued on this device until the PC acknowledges
                  it.
                </p>
              ) : null}
              {unheard.length ? (
                <details className="px-2 pt-1 text-xs">
                  <summary>Unheard updates ({unheard.length})</summary>
                  <ul className="max-h-24 overflow-y-auto overscroll-contain wrap-anywhere">
                    {unheard.map((update) => (
                      <li key={update.id} className="mt-1">
                        {update.text}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </ComposerBanner.Root>
          </section>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setExpanded(!expanded)}>
            Call Otis
          </Button>
        )}
        {expanded ? (
          <PopoverPopup
            aria-label="Otis call controls"
            anchor={anchorRef}
            side="top"
            align="end"
            sideOffset={8}
            initialFocus={false}
            finalFocus={false}
            padding="none"
            width="md"
          >
            <section
              aria-label={active ? "Otis call settings" : "Otis call"}
              className="flex max-h-[min(var(--available-height),calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-1.5rem))] min-h-0 w-full flex-col"
            >
              <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2">
                <p className="text-sm font-medium">Call settings</p>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Close call settings"
                  onClick={() => setExpanded(false)}
                >
                  <XIcon />
                </Button>
              </div>
              <div
                data-slot="call-panel-scroll"
                className="min-h-0 overflow-y-auto overscroll-contain px-3 pb-3 wrap-anywhere"
              >
                <CallModelSelectors
                  environmentId={props.environmentId}
                  models={models}
                  instanceEntries={props.instanceEntries}
                  modelOptionsByInstance={props.modelOptionsByInstance}
                  onChange={(next) => void configure(next)}
                  disabled={!configurationReady && !configurationError}
                />
                <p className="mt-1 text-xs">Changes apply to the next turn.</p>
                <Button
                  type="button"
                  size="sm-multiline"
                  variant="outline"
                  disabled={
                    !configurationReady ||
                    props.isDraft ||
                    !models.voice.model ||
                    !models.operator.model
                  }
                  onClick={() => void configure(models, true)}
                >
                  Use these models by default
                </Button>
                {configurationError && !active ? (
                  <p role="alert" className="mt-2 text-xs">
                    {configurationError}
                  </p>
                ) : null}
                {!active ? (
                  <p className="mt-3 text-xs">
                    The voice model handles conversation while the background agent works with this
                    chat's permissions. Recordings save on this device, then on your PC before
                    transcription. Ending the call leaves the chat working.
                  </p>
                ) : null}
              </div>
              {!active ? (
                <div data-slot="call-panel-actions" className="flex shrink-0 border-t p-3">
                  <Button
                    type="button"
                    size="sm-multiline"
                    className="w-full"
                    disabled={
                      !props.enabled ||
                      !configurationReady ||
                      !models.voice.model ||
                      !models.operator.model
                    }
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
                </div>
              ) : null}
            </section>
          </PopoverPopup>
        ) : null}
      </div>
    </Popover>
  );
}
