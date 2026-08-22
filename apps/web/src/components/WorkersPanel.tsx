import type {
  EnvironmentId,
  ThreadId,
  WorkerContextPackage,
  WorkerContextReference,
  WorkerDetail,
  WorkerId,
  WorkerMessage,
  WorkerStatus,
  WorkerSummary,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  Activity,
  CircleAlert,
  Eye,
  Hourglass,
  MessageSquare,
  Pause,
  Play,
  Send,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { workerListInput } from "@t3tools/client-runtime/state/workers";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import { workerEnvironment } from "../state/workers";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

const ACTIVE_STATUSES: ReadonlySet<WorkerStatus> = new Set([
  "starting",
  "running",
  "waitingApproval",
]);

const EMPTY_WORKERS: ReadonlyArray<WorkerSummary> = [];

const WORKERS_PANEL_RESPONSIVE_CLASSES = {
  root: "flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden",
  panes:
    "grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(10rem,.75fr)_minmax(0,1.25fr)] max-[680px]:grid-cols-1",
  startControl:
    "min-h-11 min-w-0 w-full rounded border border-border bg-background px-2 text-xs outline-none focus:border-ring",
} as const;

export function resolveSelectedWorkerId(
  current: WorkerId | null,
  workers: ReadonlyArray<Pick<WorkerSummary, "id">>,
): WorkerId | null {
  if (current !== null && workers.some((worker) => worker.id === current)) return current;
  return workers[0]?.id ?? null;
}

export function parseWorkerContextInputs(input: {
  readonly note: string;
  readonly references: string;
  readonly snippets: string;
}): WorkerContextPackage {
  const references = input.references
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const symbolSeparator = line.lastIndexOf("#");
      const pathAndRange = (symbolSeparator < 0 ? line : line.slice(0, symbolSeparator)).trim();
      const symbol = symbolSeparator < 0 ? "" : line.slice(symbolSeparator + 1).trim();
      if (symbolSeparator >= 0 && !symbol) {
        throw new Error(`Context reference ${index + 1} has an empty symbol`);
      }

      const rangeMatch = /:(\d+)(?:-(\d+))?$/.exec(pathAndRange);
      const path = (rangeMatch ? pathAndRange.slice(0, rangeMatch.index) : pathAndRange).trim();
      if (!path) {
        throw new Error(`Context reference ${index + 1} requires a path`);
      }

      let lineStart: number | undefined;
      let lineEnd: number | undefined;
      if (rangeMatch) {
        lineStart = Number(rangeMatch[1]);
        lineEnd = Number(rangeMatch[2] ?? rangeMatch[1]);
        if (lineStart < 1 || lineEnd < lineStart) {
          throw new Error(`Context reference ${index + 1} has an invalid line range`);
        }
      }

      return {
        path,
        ...(lineStart === undefined || lineEnd === undefined ? {} : { lineStart, lineEnd }),
        ...(symbol ? { symbol } : {}),
      } satisfies WorkerContextReference;
    });

  const snippets = input.snippets
    .split(/\r?\n/)
    .map((snippet) => snippet.trim())
    .filter(Boolean);

  return {
    ...(input.note.trim() ? { note: input.note.trim() } : {}),
    references,
    snippets,
  };
}

const STATUS_LABELS: Record<WorkerStatus, string> = {
  starting: "Starting",
  running: "Working",
  waitingApproval: "Approval needed",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  lost: "Lost",
  closed: "Closed",
};

const STATUS_DOTS: Record<WorkerStatus, string> = {
  starting: "bg-info",
  running: "bg-info",
  waitingApproval: "bg-warning",
  completed: "bg-success",
  failed: "bg-destructive",
  interrupted: "bg-muted-foreground",
  lost: "bg-destructive",
  closed: "bg-muted-foreground/50",
};

export function workerStatusLabel(status: WorkerStatus): string {
  return STATUS_LABELS[status];
}

export function workerCardSummary(
  worker: Pick<WorkerSummary, "latestDirectMessage" | "latestObserverReport">,
): string {
  const directMessage = worker.latestDirectMessage?.body.trim();
  const observerReport =
    worker.latestObserverReport?.progress?.trim() || worker.latestObserverReport?.report.trim();

  if (directMessage && observerReport) {
    return Date.parse(worker.latestDirectMessage!.createdAt) >=
      Date.parse(worker.latestObserverReport!.generatedAt)
      ? directMessage
      : observerReport;
  }
  return directMessage || observerReport || "Awaiting worker report";
}

function formatTokens(total: number): string {
  if (total < 1_000) return `${total}`;
  if (total < 1_000_000) return `${(total / 1_000).toFixed(total < 10_000 ? 1 : 0)}k`;
  return `${(total / 1_000_000).toFixed(1)}m`;
}

function elapsedLabel(startedAt: string, endedAt?: string): string {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function StatusPill({ status }: { status: WorkerStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[.7rem] text-muted-foreground">
      <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOTS[status])} />
      {workerStatusLabel(status)}
    </span>
  );
}

function WorkerRow({
  worker,
  selected,
  onSelect,
}: {
  worker: WorkerSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "w-full border-b border-border/50 px-3 py-2.5 text-left transition hover:bg-accent/50",
        selected && "bg-accent/70",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{worker.title}</span>
        <StatusPill status={worker.status} />
        {worker.unreadMessageCount > 0 ? (
          <span className="rounded-full bg-info px-1.5 text-[.65rem] font-semibold text-white">
            {worker.unreadMessageCount}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-center gap-2 truncate font-mono text-[.65rem] text-muted-foreground/80">
        <span>{worker.model}</span>
        <span aria-hidden>·</span>
        <span>{worker.runtimeMode}</span>
        <span aria-hidden>·</span>
        <span>
          {elapsedLabel(
            worker.createdAt,
            worker.status === "closed" ? worker.updatedAt : undefined,
          )}
        </span>
        <span aria-hidden>·</span>
        <span>{formatTokens(worker.usage.totalTokens)} tok</span>
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground">{workerCardSummary(worker)}</p>
    </button>
  );
}

function MessageBubble({ message }: { message: WorkerMessage }) {
  const isParent = message.author === "parent";
  const isObserver = message.author === "observer";
  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2",
        isObserver ? "border-info/30 bg-info/5" : "border-border/60 bg-card/40",
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        {isParent ? (
          <UserRound className="size-3" />
        ) : isObserver ? (
          <Eye className="size-3" />
        ) : (
          <MessageSquare className="size-3" />
        )}
        {isParent ? "Parent" : isObserver ? "Observer" : message.author}
        <span className="ml-auto font-normal normal-case">{message.kind}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">{message.body}</p>
    </div>
  );
}

function WorkerDetailView({
  detail,
  environmentId,
  onRefresh,
}: {
  detail: WorkerDetail;
  environmentId: EnvironmentId;
  onRefresh: () => void;
}) {
  const [followUp, setFollowUp] = useState("");
  const send = useAtomCommand(workerEnvironment.send, { reportFailure: false });
  const wait = useAtomCommand(workerEnvironment.wait, { reportFailure: false });
  const observe = useAtomCommand(workerEnvironment.observe, { reportFailure: false });
  const interrupt = useAtomCommand(workerEnvironment.interrupt, { reportFailure: false });
  const close = useAtomCommand(workerEnvironment.close, { reportFailure: false });
  const respondToApproval = useAtomCommand(workerEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const summary = detail.summary;
  const latestObserverReport = detail.observerReports.at(-1) ?? summary.latestObserverReport;
  const active = ACTIVE_STATUSES.has(summary.status);
  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    await action();
    setBusy(null);
    onRefresh();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold">{summary.title}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <StatusPill status={summary.status} />
              <span className="font-mono text-[.65rem] text-muted-foreground">{summary.model}</span>
              <span className="font-mono text-[.65rem] text-muted-foreground">
                {summary.runtimeMode}
              </span>
            </div>
          </div>
          <span className="font-mono text-[.65rem] text-muted-foreground">
            {formatTokens(summary.usage.totalTokens)} tok
          </span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1.5 text-[.65rem] text-muted-foreground">
          <span className="rounded border border-border/50 px-1.5 py-1">
            Elapsed {elapsedLabel(summary.createdAt, active ? undefined : summary.updatedAt)}
          </span>
          <span className="rounded border border-border/50 px-1.5 py-1">
            Activations {summary.activationCount}
          </span>
          <span className="rounded border border-border/50 px-1.5 py-1">
            Backend {summary.backend}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {active ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run("wait", () =>
                  wait({
                    environmentId,
                    input: { workerIds: [summary.id], timeoutMillis: 30_000 },
                  }),
                )
              }
            >
              <Hourglass className="size-3" /> Wait
            </Button>
          ) : null}
          {active ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run("observe", () =>
                  observe({ environmentId, input: { workerId: summary.id } }),
                )
              }
            >
              <Eye className="size-3" /> Observe
            </Button>
          ) : null}
          {active ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run("interrupt", () =>
                  interrupt({
                    environmentId,
                    input: { workerId: summary.id, reason: "Interrupted from Worker inbox" },
                  }),
                )
              }
            >
              <Pause className="size-3" /> Interrupt
            </Button>
          ) : null}
          {summary.status !== "closed" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                void run("close", () => close({ environmentId, input: { workerId: summary.id } }))
              }
            >
              <X className="size-3" /> Close
            </Button>
          ) : null}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          <section className="rounded-md border border-border/60 bg-card/30 p-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
              <Play className="size-3" /> Assignment
            </div>
            <p className="whitespace-pre-wrap text-xs leading-relaxed">{detail.assignment}</p>
            <p className="mt-2 text-[.7rem] text-muted-foreground">
              Context:{" "}
              {detail.context.note?.trim() || "Explicit paths and notes were not supplied."}
            </p>
            {detail.context.references.length > 0 ? (
              <p className="mt-1 font-mono text-[.65rem] text-muted-foreground/80">
                {detail.context.references.map((reference) => reference.path).join(" · ")}
              </p>
            ) : null}
          </section>

          {detail.pendingApproval ? (
            <section className="rounded-md border border-warning/40 bg-warning/5 p-2.5">
              <div className="flex items-center gap-1.5 text-[.7rem] font-medium">
                <CircleAlert className="size-3.5 text-warning-foreground" /> Approval requested
              </div>
              <p className="mt-1 text-xs">{detail.pendingApproval.summary}</p>
              <div className="mt-2 flex gap-1.5">
                {(["accept", "decline", "cancel"] as const).map((decision) => (
                  <Button
                    key={decision}
                    size="xs"
                    variant={decision === "accept" ? "default" : "outline"}
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`approval-${decision}`, () =>
                        respondToApproval({
                          environmentId,
                          input: {
                            workerId: summary.id,
                            requestId: detail.pendingApproval!.requestId,
                            decision,
                          },
                        }),
                      )
                    }
                  >
                    {decision[0]!.toUpperCase() + decision.slice(1)}
                  </Button>
                ))}
              </div>
            </section>
          ) : null}

          {latestObserverReport ? (
            <section className="rounded-md border border-info/30 bg-info/5 p-2.5">
              <div className="flex items-center gap-1.5 text-[.65rem] font-medium uppercase tracking-wider text-info-foreground">
                <Eye className="size-3" /> Observer report
              </div>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">
                {latestObserverReport.report}
              </p>
              {latestObserverReport.blockers.length > 0 ? (
                <p className="mt-1 text-[.7rem] text-warning-foreground">
                  Blockers: {latestObserverReport.blockers.join(" · ")}
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="space-y-2">
            <div className="flex items-center gap-1.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
              <MessageSquare className="size-3" /> Communication
            </div>
            {detail.messages.length > 0 ? (
              detail.messages.map((message) => <MessageBubble key={message.id} message={message} />)
            ) : (
              <p className="text-xs text-muted-foreground">No direct messages yet.</p>
            )}
          </section>

          <section className="rounded-md border border-border/60 p-2">
            <label
              className="mb-1 block text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground"
              htmlFor="worker-follow-up"
            >
              Follow-up assignment
            </label>
            <textarea
              id="worker-follow-up"
              value={followUp}
              onChange={(event) => setFollowUp(event.target.value)}
              placeholder={
                summary.resumable
                  ? "Give this worker its next bounded assignment…"
                  : "Worker is not resumable"
              }
              disabled={!summary.resumable || busy !== null}
              className="min-h-16 w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-ring"
            />
            <Button
              className="mt-2"
              size="xs"
              disabled={!summary.resumable || !followUp.trim() || busy !== null}
              onClick={() =>
                void run("send", async () => {
                  const result = await send({
                    environmentId,
                    input: { workerId: summary.id, message: followUp.trim() },
                  });
                  if (result._tag === "Success") setFollowUp("");
                  return result;
                })
              }
            >
              <Send className="size-3" /> Send follow-up
            </Button>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

export function WorkersPanel({
  environmentId,
  parentThreadId,
  enabled = true,
}: {
  environmentId: EnvironmentId;
  parentThreadId: ThreadId;
  enabled?: boolean;
}) {
  const [selectedWorkerId, setSelectedWorkerId] = useState<WorkerId | null>(null);
  const [title, setTitle] = useState("");
  const [assignment, setAssignment] = useState("");
  const [contextNote, setContextNote] = useState("");
  const [contextReferences, setContextReferences] = useState("");
  const [contextSnippets, setContextSnippets] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const listQuery = useEnvironmentQuery(
    enabled
      ? workerEnvironment.list({ environmentId, input: workerListInput(parentThreadId) })
      : null,
  );
  const detailQuery = useEnvironmentQuery(
    enabled && selectedWorkerId
      ? workerEnvironment.detail({ environmentId, input: { workerId: selectedWorkerId } })
      : null,
  );
  const liveEvents = useAtomValue(
    workerEnvironment.events({ environmentId, input: { parentThreadId, includeClosed: true } }),
  );
  const start = useAtomCommand(workerEnvironment.start, { reportFailure: false });
  const workers = listQuery.data?.workers ?? EMPTY_WORKERS;
  const eventConnected = liveEvents._tag === "Success" || liveEvents.waiting;
  const selected = workers.find((worker) => worker.id === selectedWorkerId) ?? workers[0] ?? null;

  useEffect(() => {
    setSelectedWorkerId((current) => resolveSelectedWorkerId(current, workers));
  }, [workers]);

  // Keep the detail pane aligned with the first available Worker after the
  // initial list load, and recover gracefully when a closed/removed Worker
  // disappears during a refresh.
  useEffect(() => {
    if (liveEvents._tag !== "Success") return;
    listQuery.refresh();
    if (selectedWorkerId !== null) detailQuery.refresh();
  }, [detailQuery.refresh, listQuery.refresh, liveEvents, selectedWorkerId]);

  const aggregate = useMemo(
    () => ({
      active: workers.filter((worker) => ACTIVE_STATUSES.has(worker.status)).length,
      tokens: workers.reduce((total, worker) => total + worker.usage.totalTokens, 0),
    }),
    [workers],
  );

  if (!enabled) return null;

  const submitStart = async () => {
    if (!title.trim() || !assignment.trim()) return;
    setStartError(null);
    let context: WorkerContextPackage;
    try {
      context = parseWorkerContextInputs({
        note: contextNote,
        references: contextReferences,
        snippets: contextSnippets,
      });
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Explicit context is invalid.");
      return;
    }
    const result = await start({
      environmentId,
      input: {
        title: title.trim(),
        assignment: assignment.trim(),
        context,
        parentThreadId,
      },
    });
    if (result._tag === "Success") {
      setSelectedWorkerId(result.value.summary.id);
      setTitle("");
      setAssignment("");
      setContextNote("");
      setContextReferences("");
      setContextSnippets("");
    } else {
      setStartError("Could not start Worker. Check the server status and try again.");
    }
  };

  return (
    <div className={WORKERS_PANEL_RESPONSIVE_CLASSES.root}>
      <div className="border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Activity className="size-3.5 text-info-foreground" />
          <span className="text-sm font-semibold">Workers</span>
          <span className="ml-auto font-mono text-[.65rem] text-muted-foreground">
            {aggregate.active} active · {formatTokens(aggregate.tokens)} tok
          </span>
          <span
            className={cn(
              "size-1.5 rounded-full",
              eventConnected ? "bg-success" : "bg-muted-foreground/40",
            )}
            title={eventConnected ? "Live Worker updates" : "Waiting for Worker updates"}
          />
        </div>
        <div className="mt-2 grid gap-1.5">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Worker title"
            aria-label="Worker title"
            className={WORKERS_PANEL_RESPONSIVE_CLASSES.startControl}
          />
          <textarea
            value={assignment}
            onChange={(event) => setAssignment(event.target.value)}
            placeholder="Bounded assignment"
            aria-label="Bounded assignment"
            className={cn(WORKERS_PANEL_RESPONSIVE_CLASSES.startControl, "min-h-16 resize-y py-2")}
          />
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-1.5 max-[480px]:grid-cols-1">
            <input
              value={contextNote}
              onChange={(event) => setContextNote(event.target.value)}
              placeholder="Explicit context note (optional)"
              aria-label="Explicit context note"
              className={WORKERS_PANEL_RESPONSIVE_CLASSES.startControl}
            />
            <Button
              className="min-h-11 max-[480px]:w-full"
              disabled={!title.trim() || !assignment.trim()}
              onClick={() => void submitStart()}
            >
              <Play className="size-3" /> Start
            </Button>
          </div>
          <details className="min-w-0 rounded border border-border/60 bg-card/20">
            <summary className="flex min-h-11 cursor-pointer items-center px-2 text-xs text-muted-foreground">
              Explicit paths and snippets
            </summary>
            <div className="grid min-w-0 gap-2 border-t border-border/60 p-2">
              <label className="grid min-w-0 gap-1 text-[.7rem] text-muted-foreground">
                References — one per line: path:10-20#symbol
                <textarea
                  value={contextReferences}
                  onChange={(event) => setContextReferences(event.target.value)}
                  placeholder="apps/server/src/worker/WorkerStore.ts:10-40#WorkerStore"
                  className={cn(
                    WORKERS_PANEL_RESPONSIVE_CLASSES.startControl,
                    "min-h-16 resize-y py-2 font-mono",
                  )}
                />
              </label>
              <label className="grid min-w-0 gap-1 text-[.7rem] text-muted-foreground">
                Snippets — one explicit snippet per line
                <textarea
                  value={contextSnippets}
                  onChange={(event) => setContextSnippets(event.target.value)}
                  placeholder="Paste only the text this Worker needs."
                  className={cn(
                    WORKERS_PANEL_RESPONSIVE_CLASSES.startControl,
                    "min-h-16 resize-y py-2 font-mono",
                  )}
                />
              </label>
            </div>
          </details>
          {startError ? (
            <p className="text-[.7rem] text-destructive-foreground">{startError}</p>
          ) : null}
        </div>
      </div>

      <div className={WORKERS_PANEL_RESPONSIVE_CLASSES.panes}>
        <ScrollArea className="min-h-0 border-r border-border/60 max-[680px]:max-h-52 max-[680px]:border-r-0 max-[680px]:border-b">
          {listQuery.isPending && workers.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">Loading Workers…</p>
          ) : null}
          {listQuery.error ? (
            <p className="p-3 text-xs text-destructive-foreground">{listQuery.error}</p>
          ) : null}
          {!listQuery.isPending && !listQuery.error && workers.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">
              No Workers for this thread yet.
            </p>
          ) : null}
          {workers.map((worker) => (
            <WorkerRow
              key={worker.id}
              worker={worker}
              selected={worker.id === selected?.id}
              onSelect={() => setSelectedWorkerId(worker.id)}
            />
          ))}
        </ScrollArea>
        {detailQuery.data && detailQuery.data.summary.id === selected?.id ? (
          <WorkerDetailView
            environmentId={environmentId}
            detail={detailQuery.data}
            onRefresh={detailQuery.refresh}
          />
        ) : (
          <div className="flex items-center justify-center p-6 text-center text-xs text-muted-foreground">
            {selected
              ? detailQuery.isPending
                ? "Loading Worker detail…"
                : (detailQuery.error ?? "Select a Worker to inspect its communication.")
              : "Start or select a Worker to inspect its communication."}
          </div>
        )}
      </div>
    </div>
  );
}
