import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OtisFront,
  type OtisFrontUpdate,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";
import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentScope } from "~/state/session";
import { startFrontCall, useFrontCall } from "./CallBar";
import { Conversation } from "./Conversation";
import { FrontTaskDashboard, type RunFrontAction } from "./FrontCard";
import { FrontComposer } from "./FrontComposer";
import { FrontTopBar } from "./FrontTopBar";
import { MorningReportCard } from "./MorningReportCard";
import { NowPanel } from "./NowPanel";
import { frontSpeechMessage } from "./front.logic";
import { applyConversationEvent, followFront, frontCommands, mergeHistory } from "./frontData";

const chicagoDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  dateStyle: "short",
});
const blankItems = new Map<string, OtisFront.ConversationItem>();

export function OtisFrontView({
  environmentId,
  background = false,
}: {
  environmentId: EnvironmentId;
  background?: boolean;
}) {
  const gt = useGT();
  const voice = useFrontCall(environmentId);
  const onCall = voice.state !== "idle";
  const activeSpeech = useRef<
    (ReturnType<typeof frontSpeechMessage> & { onPlayed?: () => void })[]
  >([]);
  const playbackGeneration = useRef(0);
  const canCall = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const cannotTurn = !useAtomValue(frontCommands.turn.permissionAtom(environmentId));
  const cannotCancel = !useAtomValue(frontCommands.cancel.permissionAtom(environmentId));
  const cannotAct = !useAtomValue(frontCommands.action.permissionAtom(environmentId));
  const [state, setState] = useState<OtisFront.FrontState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [taskDashboardUrl, setTaskDashboardUrl] = useState<string>();
  const [revision, retryStream] = useState(0);
  const [items, setItems] = useState<ReadonlyMap<string, OtisFront.ConversationItem>>(blankItems);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<OtisFront.MorningReport | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<OtisFront.TurnRequest | null>(null);
  const cursor = useRef<number | undefined>(undefined);
  const content = useRef<ReadonlyMap<string, OtisFront.ConversationItem>>(blankItems);
  const fetchOlder = useRef<(before?: string) => Promise<void>>(async () => {});
  const actionRequests = useRef(new Map<string, string>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the subscription, page requests and their generation across resets.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let generation = 0;
    let reportFetch = 0;
    let gotState = false;
    function replace(nextItems: ReadonlyMap<string, OtisFront.ConversationItem>) {
      if (nextItems === content.current) return;
      content.current = nextItems;
      setItems(nextItems);
    }
    async function history(before?: string) {
      const requestGeneration = generation;
      try {
        const page = await Effect.runPromise(
          frontCommands.history.run(appAtomRegistry, {
            environmentId,
            input: { limit: 50, ...(before ? { before } : {}) },
          }),
          { signal },
        );
        if (signal.aborted || requestGeneration !== generation) return;
        replace(mergeHistory(content.current, page.items));
        setNext(page.next);
        setLoading(false);
      } catch {
        if (!signal.aborted && requestGeneration === generation) setLoading(false);
      }
    }
    async function latestReport() {
      const request = ++reportFetch;
      try {
        const value = await Effect.runPromise(
          frontCommands.report.run(appAtomRegistry, {
            environmentId,
            input: undefined,
          }),
          { signal },
        );
        if (!signal.aborted && request === reportFetch) setReport(value);
      } catch {}
    }
    function speech(event: typeof OtisFront.SpeakEvent.Type) {
      if (!voice.session.current?.isActive) return;
      const item = content.current.get(event.itemId);
      const message = frontSpeechMessage(
        { event, turnId: item?.turnId ?? null },
        playbackGeneration.current,
      );
      const onPlayed = () => {
        activeSpeech.current = activeSpeech.current.filter(({ id }) => id !== message.id);
        if (!item)
          void Effect.runPromise(
            frontCommands.action.run(appAtomRegistry, {
              environmentId,
              input: {
                actionId: "report:played",
                requestId: `report:played:${event.itemId}`,
                input: event.itemId,
              },
            }),
            { signal },
          ).then(
            () => latestReport(),
            () => {},
          );
      };
      activeSpeech.current.push({ ...message, onPlayed });
    }
    function onEvent(event: OtisFrontUpdate) {
      if (event.type === "unavailable") {
        gotState = false;
        setUnavailable(true);
        return;
      }
      if (event.type === "connected") {
        setUnavailable(false);
        setTaskDashboardUrl(event.taskDashboardUrl);
        return;
      }
      const replay =
        event.type !== "reset" && cursor.current !== undefined && event.seq <= cursor.current;
      if (replay && event.type !== "state") return;
      if (!replay) cursor.current = event.seq;
      if (event.type === "reset") {
        generation++;
        gotState = false;
        playbackGeneration.current++;
        setNext(null);
        setState(null);
        setReport(null);
        setLoading(true);
      }
      replace(applyConversationEvent(content.current, event));
      if (event.type === "state") {
        setState((previous) =>
          previous && previous.seq > event.state.seq ? previous : event.state,
        );
        setUnavailable(false);
        if (!gotState) {
          gotState = true;
          void history();
          void latestReport();
        }
      } else if (event.type === "report") {
        void latestReport();
      } else if (event.type === "speak") {
        speech(event);
      }
      const running = [...content.current.values()].findLast(
        (item) => item.status === "streaming" && item.turnId,
      );
      const speakingTurnId = activeSpeech.current.find((message) => message.turnId)?.turnId;
      voice.session.current?.observe(
        activeSpeech.current,
        !!running,
        speakingTurnId ?? running?.turnId ?? undefined,
      );
    }
    fetchOlder.current = history;
    void followFront(environmentId, () => cursor.current, onEvent, signal).catch(() => {
      if (!signal.aborted) setUnavailable(true);
    });
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry now restarts the stream with the current cursor.
  }, [environmentId, revision, voice.session]);

  const liveCallId = onCall ? voice.call?.callId : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Tell Front Door when the microphone call opens so it can deliver the unread report.
  useEffect(() => {
    if (!liveCallId) return;
    void Effect.runPromise(
      frontCommands.action.run(appAtomRegistry, {
        environmentId,
        input: {
          actionId: "report:call-open",
          requestId: `report:call-open:${liveCallId}`,
          input: liveCallId,
        },
      }),
    ).catch(() => {});
  }, [environmentId, liveCallId]);

  const ordered = [...items.values()].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  );
  const streaming = ordered.findLast((item) => item.status === "streaming" && item.turnId)?.turnId;

  function showError(title: string) {
    toastManager.add({ type: "error", title });
  }

  async function submit(input: OtisFront.TurnRequest) {
    setPending(true);
    setFailed(null);
    try {
      await Effect.runPromise(frontCommands.turn.run(appAtomRegistry, { environmentId, input }));
    } catch {
      setFailed(input);
    } finally {
      setPending(false);
    }
  }

  function send(text: string) {
    void submit({ text, channel: "typed", clientTurnId: randomUUID() });
  }

  async function stop(turnId: string) {
    setPending(true);
    try {
      await Effect.runPromise(
        frontCommands.cancel.run(appAtomRegistry, { environmentId, input: { turnId } }),
      );
    } catch {
      showError(gt("Otis could not stop the reply."));
    } finally {
      setPending(false);
    }
  }

  const run: RunFrontAction = async (action, input) => {
    const key = JSON.stringify([action.id, input]);
    const requestId = actionRequests.current.get(key) ?? randomUUID();
    actionRequests.current.set(key, requestId);
    try {
      const result = await Effect.runPromise(
        frontCommands.action.run(appAtomRegistry, {
          environmentId,
          input: { actionId: action.id, requestId, ...(input === undefined ? {} : { input }) },
        }),
      );
      actionRequests.current.delete(key);
      if (result.message)
        toastManager.add({ title: result.message, type: result.accepted ? "success" : "error" });
    } catch (error) {
      showError(gt("Otis could not confirm the action."));
      throw error;
    }
  };

  async function heard(reportId: string) {
    try {
      const result = await Effect.runPromise(
        frontCommands.heard.run(appAtomRegistry, { environmentId, input: { reportId } }),
      );
      setReport((current) =>
        current?.reportId === result.reportId ? { ...current, heardAt: result.heardAt } : current,
      );
    } catch {
      showError(gt("Otis could not mark the report heard."));
    }
  }

  async function play(current: OtisFront.MorningReport) {
    try {
      const input = liveCallId
        ? JSON.stringify({ reportId: current.reportId, callId: liveCallId })
        : current.reportId;
      await run({ id: "report:play", label: "", confirm: null, input: null }, input);
    } catch {
      // The action reports the failed request and retains its retry ID.
    }
  }

  function call() {
    activeSpeech.current = [];
    void startFrontCall(voice);
  }

  const visibleReport =
    report &&
    (!report.heardAt || chicagoDay.format(new Date(report.heardAt)) === chicagoDay.format());
  return (
    <main
      inert={background || undefined}
      className="@container flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
    >
      <FrontTopBar state={state} canCall={canCall} onCall={onCall} onStart={call} />
      <NowPanel
        state={state}
        unavailable={unavailable}
        retry={() => retryStream((value) => value + 1)}
        run={run}
        disabled={cannotAct || unavailable}
      />
      <FrontTaskDashboard value={taskDashboardUrl}>
        {visibleReport && (
          <MorningReportCard
            key={report.reportId}
            report={report}
            run={run}
            disabled={cannotAct || unavailable}
            play={() => play(report)}
            heard={() => heard(report.reportId)}
          />
        )}
        <Conversation
          environmentId={environmentId}
          items={ordered}
          loading={loading}
          older={next !== null}
          loadOlder={() => (next ? fetchOlder.current(next) : Promise.resolve())}
          run={run}
          retry={send}
          disabled={cannotTurn || unavailable || pending}
        />
      </FrontTaskDashboard>
      {failed && (
        <div
          role="alert"
          className="flex items-center justify-center gap-2 px-3 text-xs text-destructive"
        >
          {gt("Message could not be sent.")}{" "}
          <button
            type="button"
            className="min-h-8 underline"
            disabled={cannotTurn || unavailable || pending}
            onClick={() => void submit(failed)}
          >
            {gt("Try again")}
          </button>
        </div>
      )}
      <FrontComposer
        environmentId={environmentId}
        state={state}
        voice={voice}
        disabled={unavailable || (streaming ? cannotCancel : cannotTurn)}
        stopping={!!streaming}
        pending={pending}
        onSend={send}
        onStop={() => {
          if (streaming) void stop(streaming);
        }}
      />
    </main>
  );
}
