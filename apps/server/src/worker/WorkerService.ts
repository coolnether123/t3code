import {
  ApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkerActivationId,
  WorkerId,
  WorkerMessageId,
  WorkerWaitLeaseId,
  WorkerOperationError,
  type ProviderRuntimeEvent,
  type OrchestrationThreadActivity,
  type TurnId,
  type WorkerActivation,
  type WorkerApprovalDecision,
  type WorkerDetail,
  type WorkerEvent,
  type WorkerInterruptInput,
  type WorkerListInput,
  type WorkerListResult,
  type WorkerMessage,
  type WorkerObserveInput,
  type WorkerObserverReport,
  type WorkerSendInput,
  type WorkerStartInput,
  type WorkerSummary,
  type WorkerTokenUsage,
  type WorkerWaitInput,
  type WorkerWaitResult,
  type WorkerWakeEvent,
  workerDisplayNameFor,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  WORKER_PROVIDER_THREAD_PREFIX,
  WorkerBackend,
  runtimeModeFromPermission,
} from "./WorkerBackend.ts";
import { WorkerObserver } from "./WorkerObserver.ts";
import { WorkerStore, type StoredWorker } from "./WorkerStore.ts";
import { projectWorkerActivities } from "./WorkerActivityProjection.ts";
import { buildWorkerEfficiencyOverview } from "./WorkerMetrics.ts";
import { projectWorkerSummaryUsage, projectWorkerUsageSnapshot } from "./WorkerUsage.ts";

const modelFallback = TrimmedNonEmptyString.make("gpt-5.6-luna");
const zeroUsage = (): WorkerTokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

const projectWorkerTokenUsage = (usage: Record<string, unknown> | undefined): WorkerTokenUsage =>
  projectWorkerUsageSnapshot(usage).cumulative;
const isWorkerOperationError = Schema.is(WorkerOperationError);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function workerStartLineage(
  activity: OrchestrationThreadActivity,
): { readonly workerId: string; readonly parentTurnId: TurnId } | undefined {
  if (activity.kind !== "tool.completed" || activity.turnId === null) return undefined;
  const payload = record(activity.payload);
  if (payload?.itemType !== "mcp_tool_call") return undefined;
  const data = record(payload.data);
  const item = record(data?.item);
  const rawTool = data?.toolName ?? item?.tool ?? data?.tool;
  if (typeof rawTool !== "string" || (rawTool.split("__").at(-1) ?? rawTool) !== "worker_start") {
    return undefined;
  }
  const result = record(item?.result ?? data?.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const entry of content) {
    const text = record(entry)?.text;
    if (typeof text !== "string") continue;
    try {
      const decoded = record(JSON.parse(text));
      const summary = record(decoded?.summary);
      if (typeof summary?.id === "string") {
        return { workerId: summary.id, parentTurnId: activity.turnId };
      }
    } catch {
      // Historical result text may not be JSON. It cannot prove lineage.
    }
  }
  return undefined;
}

export interface WorkerStartRequest {
  readonly parentThreadId: ThreadId;
  readonly parentTurnId?: TurnId | undefined;
  readonly providerInstanceId: ProviderInstanceId;
  readonly input: WorkerStartInput;
}

export interface WorkerServiceShape {
  readonly isLinkedProviderThread?: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, WorkerOperationError>;
  readonly start: (input: WorkerStartRequest) => Effect.Effect<WorkerDetail, WorkerOperationError>;
  readonly list: (input: WorkerListInput) => Effect.Effect<WorkerListResult, WorkerOperationError>;
  readonly get: (workerId: WorkerId) => Effect.Effect<WorkerDetail, WorkerOperationError>;
  readonly send: (input: WorkerSendInput) => Effect.Effect<WorkerDetail, WorkerOperationError>;
  readonly wait: (input: WorkerWaitInput) => Effect.Effect<WorkerWaitResult, WorkerOperationError>;
  readonly observe: (
    input: WorkerObserveInput,
  ) => Effect.Effect<WorkerObserverReport, WorkerOperationError>;
  readonly interrupt: (
    input: WorkerInterruptInput,
  ) => Effect.Effect<WorkerDetail, WorkerOperationError>;
  readonly close: (workerId: WorkerId) => Effect.Effect<WorkerDetail, WorkerOperationError>;
  readonly respondToApproval: (input: {
    readonly workerId: WorkerId;
    readonly requestId: import("@t3tools/contracts").ApprovalRequestId;
    readonly decision: WorkerApprovalDecision;
  }) => Effect.Effect<WorkerDetail, WorkerOperationError>;
  readonly reconcileParentAfterRewind: (input: {
    readonly parentThreadId: ThreadId;
    readonly retainedTurnIds: ReadonlySet<TurnId>;
    readonly requestId: string;
    readonly discardUnattributed: boolean;
    readonly parentActivities?: ReadonlyArray<OrchestrationThreadActivity> | undefined;
  }) => Effect.Effect<ReadonlyArray<WorkerId>, WorkerOperationError>;
  readonly handleProviderEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, never>;
  readonly recover: Effect.Effect<void, never>;
  readonly stream: Stream.Stream<WorkerEvent>;
}

const makeWorkerService = Effect.gen(function* () {
  const store = yield* WorkerStore;
  const backend = yield* WorkerBackend;
  const observer = yield* WorkerObserver;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.unbounded<WorkerEvent>();
  const wakes = yield* PubSub.unbounded<WorkerWakeEvent>();
  const sequence = yield* Ref.make(0);
  const contentBuffers = yield* Ref.make(new Map<string, string>());
  const linkedProviderThreadIds = yield* Ref.make<ReadonlySet<string> | undefined>(undefined);

  const fail = (operation: string, message: string, cause?: unknown) =>
    new WorkerOperationError({ operation, message, ...(cause === undefined ? {} : { cause }) });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const mapWorkerError = (operation: string, message: string) => (error: unknown) =>
    isWorkerOperationError(error) ? error : fail(operation, message, error);

  const rememberProviderThread = (providerThreadId: ThreadId) =>
    Ref.update(linkedProviderThreadIds, (current) => new Set(current ?? []).add(providerThreadId));

  const loadPersistedProviderThreads = Effect.gen(function* () {
    const workers = yield* store.listWorkers({
      includeClosed: true,
      includeDiscarded: true,
      limit: 100_000,
    });
    const activations = yield* Effect.forEach(
      workers,
      (worker) => store.listActivations(worker.summary.id),
      { concurrency: 8 },
    );
    return yield* Ref.modify(linkedProviderThreadIds, (current) => {
      const providerThreadIds = new Set(current ?? []);
      for (const activation of activations.flat()) {
        providerThreadIds.add(activation.providerThreadId);
      }
      return [providerThreadIds, providerThreadIds] as const;
    });
  });

  const isLinkedProviderThread: NonNullable<WorkerServiceShape["isLinkedProviderThread"]> = (
    threadId,
  ) =>
    Ref.get(linkedProviderThreadIds).pipe(
      Effect.flatMap((current) =>
        current === undefined ? loadPersistedProviderThreads : Effect.succeed(current),
      ),
      Effect.map((providerThreadIds) => providerThreadIds.has(threadId)),
      Effect.mapError(
        mapWorkerError("worker.isLinkedProviderThread", "Worker provider-thread lookup failed"),
      ),
    );

  const read: WorkerServiceShape["get"] = (workerId) =>
    Effect.gen(function* () {
      const storedRecord = Option.getOrUndefined(yield* store.getWorker(workerId));
      if (storedRecord === undefined || storedRecord.discardedAt !== undefined)
        return yield* fail("worker.read", `Worker '${workerId}' was not found`);
      const stored = yield* ensurePersistedDisplayName(storedRecord);
      const [activations, messages, approvals, reports, providerEvents] = yield* Effect.all([
        store.listActivations(workerId),
        store.listMessages(workerId),
        store.getPendingApproval(workerId),
        store.listObserverReports(workerId),
        store.listProviderEvents(workerId),
      ]);
      const pendingApproval = Option.getOrUndefined(approvals);
      return {
        summary: projectWorkerSummaryUsage(stored.summary, providerEvents),
        assignment: stored.assignment,
        context: stored.context,
        ...(stored.instructions === undefined ? {} : { instructions: stored.instructions }),
        messages,
        activations,
        ...(pendingApproval === undefined ? {} : { pendingApproval }),
        observerReports: reports,
        activities: projectWorkerActivities(providerEvents),
      } satisfies WorkerDetail;
    }).pipe(Effect.mapError(mapWorkerError("worker.read", "Worker read failed")));

  const publish = (
    stored: StoredWorker,
    input?: {
      readonly type?: WorkerEvent["type"];
      readonly message?: WorkerMessage;
      readonly approval?: WorkerDetail["pendingApproval"];
      readonly observerReport?: WorkerObserverReport;
    },
  ) =>
    Effect.gen(function* () {
      const nextSequence = yield* Ref.updateAndGet(sequence, (value) => value + 1);
      const event = {
        sequence: nextSequence,
        workerId: stored.summary.id,
        type: input?.type ?? "updated",
        occurredAt: yield* nowIso,
        summary: stored.summary,
        ...(input?.message === undefined ? {} : { message: input.message }),
        ...(input?.approval === undefined ? {} : { approval: input.approval }),
        ...(input?.observerReport === undefined ? {} : { observerReport: input.observerReport }),
      } satisfies WorkerEvent;
      yield* PubSub.publish(changes, event).pipe(Effect.asVoid);
    });

  const wake = (event: WorkerWakeEvent) => PubSub.publish(wakes, event).pipe(Effect.asVoid);

  const saveSummary = (stored: StoredWorker, summary: WorkerSummary) => {
    const next = { ...stored, summary };
    return store.saveWorker(next).pipe(Effect.as(next));
  };

  // Legacy Worker payloads predate displayName. Repair them on the first
  // server read and write the repaired summary back so reconnects, projection
  // rebuilds, and restarts keep the same identity label.
  const ensurePersistedDisplayName = (stored: StoredWorker) => {
    const displayName = workerDisplayNameFor(stored.summary.id, stored.summary.displayName);
    if (stored.summary.displayName === displayName) return Effect.succeed(stored);
    const migrated = { ...stored, summary: { ...stored.summary, displayName } };
    return store.saveWorker(migrated).pipe(Effect.as(migrated));
  };

  const clearActiveActivation = (
    summary: WorkerSummary,
    changes: Omit<Partial<WorkerSummary>, "activeActivationId"> = {},
  ): WorkerSummary => {
    const { activeActivationId: _activeActivationId, ...withoutActiveActivation } = summary;
    return { ...withoutActiveActivation, ...changes } as WorkerSummary;
  };

  const addMessage = (stored: StoredWorker, message: WorkerMessage) =>
    Effect.gen(function* () {
      yield* store.saveMessage(message);
      const summary = {
        ...stored.summary,
        updatedAt: message.createdAt,
        lastActivityAt: message.createdAt,
        ...(message.author === "parent"
          ? {}
          : { lastDirectMessageAt: message.createdAt, latestDirectMessage: message }),
        unreadMessageCount:
          message.author === "parent"
            ? stored.summary.unreadMessageCount
            : stored.summary.unreadMessageCount + 1,
      } satisfies WorkerSummary;
      const next = yield* saveSummary(stored, summary);
      yield* publish(next, { type: "message", message });
      return next;
    });

  const updateActivation = (
    activation: WorkerActivation,
    status: WorkerActivation["status"],
    lastActivityAt: string,
    extra?: Partial<WorkerActivation>,
  ) => ({ ...activation, status, lastActivityAt, ...extra }) satisfies WorkerActivation;

  const start: WorkerServiceShape["start"] = (request) =>
    Effect.gen(function* () {
      const input = request.input;
      const workerId = WorkerId.make(yield* randomUuid);
      const providerThreadId = ThreadId.make(`${WORKER_PROVIDER_THREAD_PREFIX}${workerId}`);
      const activationId = WorkerActivationId.make(yield* randomUuid);
      const now = yield* nowIso;
      const runtimeMode =
        input.runtimeMode ?? runtimeModeFromPermission(input.permissionMode) ?? "full-access";
      const summary: WorkerSummary = {
        id: workerId,
        displayName: workerDisplayNameFor(workerId, input.displayName),
        title: input.title,
        status: "starting",
        backend: "codex",
        parentThreadId: request.parentThreadId,
        providerInstanceId: request.providerInstanceId,
        model: input.modelSelection?.model ?? modelFallback,
        runtimeMode,
        createdAt: now,
        updatedAt: now,
        activeActivationId: activationId,
        lastActivityAt: now,
        unreadMessageCount: 0,
        activationCount: 1,
        resumable: true,
        usage: zeroUsage(),
      };
      const stored: StoredWorker = {
        summary,
        assignment: input.assignment,
        context: input.context,
        ...(request.parentTurnId === undefined ? {} : { parentTurnId: request.parentTurnId }),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      };
      const activation: WorkerActivation = {
        id: activationId,
        workerId,
        status: "starting",
        providerInstanceId: request.providerInstanceId,
        providerThreadId,
        runtimeMode,
        startedAt: now,
        lastActivityAt: now,
        usageBaseline: zeroUsage(),
        usageDelta: zeroUsage(),
        ...(request.parentTurnId === undefined ? {} : { parentTurnId: request.parentTurnId }),
      };
      yield* store.saveWorker(stored);
      yield* store.saveActivation(activation);
      yield* rememberProviderThread(providerThreadId);
      const assignmentMessage: WorkerMessage = {
        id: WorkerMessageId.make(yield* randomUuid),
        workerId,
        activationId,
        author: "parent",
        kind: "assignment",
        body: input.assignment,
        createdAt: now,
      };
      yield* store.saveMessage(assignmentMessage);
      const started = yield* backend
        .start({
          providerThreadId,
          providerInstanceId: request.providerInstanceId,
          title: input.title,
          assignment: input.assignment,
          context: input.context,
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          runtimeMode,
          ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
          ...(input.sandboxMode === undefined ? {} : { sandboxMode: input.sandboxMode }),
        })
        .pipe(Effect.mapError((error) => error));
      const runningAt = yield* nowIso;
      const runningActivation = updateActivation(activation, "running", runningAt, {
        providerTurnId: started.providerTurnId,
      });
      yield* store.saveActivation(runningActivation);
      const running = yield* saveSummary(stored, {
        ...summary,
        status: "running",
        updatedAt: runningAt,
        lastActivityAt: runningAt,
      });
      yield* publish(running, { type: "created", message: assignmentMessage });
      return yield* read(workerId);
    }).pipe(Effect.mapError(mapWorkerError("worker.start", "Worker start failed")));

  const list: WorkerServiceShape["list"] = (input) =>
    store
      .listWorkers({
        ...(input.parentThreadId === undefined ? {} : { parentThreadId: input.parentThreadId }),
        includeClosed: input.includeClosed ?? false,
        limit: input.limit ?? 50,
      })
      .pipe(
        Effect.flatMap((workers) => Effect.forEach(workers, ensurePersistedDisplayName)),
        Effect.flatMap((workers) =>
          Effect.forEach(workers, (worker) =>
            worker.summary.latestDirectMessage !== undefined
              ? Effect.succeed(worker.summary)
              : store.listMessages(worker.summary.id).pipe(
                  Effect.map((messages) => {
                    const latestDirectMessage = messages.findLast(
                      (message) => message.author !== "parent",
                    );
                    return latestDirectMessage === undefined
                      ? worker.summary
                      : ({
                          ...worker.summary,
                          lastDirectMessageAt: latestDirectMessage.createdAt,
                          latestDirectMessage,
                        } satisfies WorkerSummary);
                  }),
                ),
          ),
        ),
        Effect.flatMap((workers) =>
          Effect.gen(function* () {
            const metricSources = yield* Effect.forEach(workers, (summary) =>
              Effect.all({
                summary: Effect.succeed(summary),
                activations: store.listActivations(summary.id),
                providerEvents: store.listProviderEvents(summary.id),
              }),
            );
            const parentActivities =
              input.parentThreadId === undefined || store.listParentActivities === undefined
                ? undefined
                : yield* store.listParentActivities(input.parentThreadId);
            const computedAt = yield* nowIso;
            const projectedMetricSources = metricSources.map((source) => ({
              ...source,
              summary: projectWorkerSummaryUsage(source.summary, source.providerEvents),
            }));
            return {
              workers: projectedMetricSources.map((source) => source.summary),
              overview: buildWorkerEfficiencyOverview({
                workers: projectedMetricSources,
                ...(parentActivities === undefined ? {} : { parentActivities }),
                now: computedAt,
              }),
            };
          }),
        ),
        Effect.mapError((error) => fail("worker.list", "Worker list failed", error)),
      );

  const send: WorkerServiceShape["send"] = (input) =>
    Effect.gen(function* () {
      const current = Option.getOrUndefined(yield* store.getWorker(input.workerId));
      if (current === undefined)
        return yield* fail("worker.send", `Worker '${input.workerId}' was not found`);
      if (current.summary.status === "closed")
        return yield* fail("worker.send", "Closed Workers cannot receive assignments");
      const now = yield* nowIso;
      const activationId = WorkerActivationId.make(yield* randomUuid);
      const activation: WorkerActivation = {
        id: activationId,
        workerId: input.workerId,
        status: "starting",
        providerInstanceId: current.summary.providerInstanceId,
        providerThreadId: ThreadId.make(`${WORKER_PROVIDER_THREAD_PREFIX}${input.workerId}`),
        runtimeMode: current.summary.runtimeMode,
        startedAt: now,
        lastActivityAt: now,
        usageBaseline: current.summary.usage,
        usageDelta: zeroUsage(),
      };
      yield* store.saveActivation(activation);
      yield* rememberProviderThread(activation.providerThreadId);
      const message: WorkerMessage = {
        id: WorkerMessageId.make(yield* randomUuid),
        workerId: input.workerId,
        activationId,
        author: "parent",
        kind: "followUp",
        body: input.message,
        createdAt: now,
      };
      const withMessage = yield* addMessage(current, message);
      const sent = yield* backend.send({
        providerThreadId: activation.providerThreadId,
        providerInstanceId: current.summary.providerInstanceId,
        title: current.summary.title,
        message: input.message,
        ...(input.context === undefined ? {} : { context: input.context }),
        modelSelection: {
          instanceId: current.summary.providerInstanceId,
          model: current.summary.model,
        },
        runtimeMode: current.summary.runtimeMode,
      });
      const runningAt = yield* nowIso;
      yield* store.saveActivation(
        updateActivation(activation, "running", runningAt, {
          providerTurnId: sent.providerTurnId,
        }),
      );
      yield* saveSummary(withMessage, {
        ...withMessage.summary,
        status: "running",
        activeActivationId: activationId,
        activationCount: withMessage.summary.activationCount + 1,
        updatedAt: runningAt,
        lastActivityAt: runningAt,
      });
      return yield* read(input.workerId);
    }).pipe(Effect.mapError(mapWorkerError("worker.send", "Worker send failed")));

  const wait: WorkerServiceShape["wait"] = (input) =>
    Effect.gen(function* () {
      if (input.workerIds.length === 0)
        return yield* fail("worker.wait", "At least one Worker is required");
      const leaseId = WorkerWaitLeaseId.make(yield* randomUuid);
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);
      const deadline = DateTime.formatIso(DateTime.add(now, { milliseconds: input.timeoutMillis }));
      yield* store.saveWaitLease({
        leaseId,
        workerIds: input.workerIds,
        deadlineAt: deadline,
        status: "waiting",
        createdAt,
      });
      const matches = (event: WorkerWakeEvent) =>
        input.workerIds.includes(event.workerId) &&
        (input.until === undefined || input.until.includes(event.status));
      const readWorkers = () =>
        Effect.forEach(input.workerIds, (workerId) =>
          read(workerId).pipe(Effect.map((detail) => detail.summary)),
        );
      const result = yield* Effect.scoped(
        PubSub.subscribe(wakes).pipe(
          Effect.flatMap((subscription) =>
            Effect.race(
              Stream.fromSubscription(subscription).pipe(Stream.filter(matches), Stream.runHead),
              Effect.sleep(Duration.millis(input.timeoutMillis)).pipe(
                Effect.as(Option.none<WorkerWakeEvent>()),
              ),
            ),
          ),
        ),
      );
      const event = Option.getOrUndefined(result);
      const completedAt = yield* nowIso;
      if (event === undefined) {
        yield* store.finishWaitLease({
          leaseId,
          status: "expired",
          reason: "expired",
          completedAt,
        });
        return {
          leaseId,
          status: "expired",
          reason: "expired",
          events: [],
          workers: yield* readWorkers(),
          completedAt,
        } satisfies WorkerWaitResult;
      }
      yield* store.finishWaitLease({ leaseId, status: "woken", reason: event.reason, completedAt });
      return {
        leaseId,
        status: "woken",
        reason: event.reason,
        events: [event],
        workers: yield* readWorkers(),
        completedAt,
      } satisfies WorkerWaitResult;
    }).pipe(Effect.mapError(mapWorkerError("worker.wait", "Worker wait failed")));

  const observe: WorkerServiceShape["observe"] = (input) =>
    Effect.gen(function* () {
      const detail = yield* read(input.workerId);
      const report = yield* observer.observe({
        summary: detail.summary,
        detail,
        ...(input.focus === undefined ? {} : { focus: input.focus }),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      });
      yield* store.saveObserverReport(report);
      const current = Option.getOrUndefined(yield* store.getWorker(input.workerId));
      if (current !== undefined) {
        const next = yield* saveSummary(current, {
          ...current.summary,
          updatedAt: report.generatedAt,
          latestObserverReport: report,
        });
        yield* publish(next, { type: "observerReport", observerReport: report });
      }
      return report;
    }).pipe(Effect.mapError(mapWorkerError("worker.observe", "Worker observation failed")));

  const interrupt: WorkerServiceShape["interrupt"] = (input) =>
    Effect.gen(function* () {
      const detail = yield* read(input.workerId);
      const activation = detail.activations.find(
        (item) => item.id === detail.summary.activeActivationId,
      );
      if (activation === undefined)
        return yield* fail("worker.interrupt", "Worker has no active activation");
      if (!input.force && detail.observerReports.length === 0)
        return yield* fail(
          "worker.interrupt",
          "Observe the Worker before interrupting it, or pass force",
        );
      yield* backend.interrupt({
        providerThreadId: activation.providerThreadId,
        ...(activation.providerTurnId === undefined
          ? {}
          : { providerTurnId: activation.providerTurnId }),
      });
      const interruptedAt = yield* nowIso;
      const finished = updateActivation(activation, "interrupted", interruptedAt, {
        finishedAt: interruptedAt,
      });
      yield* store.saveActivation(finished);
      const current = Option.getOrUndefined(yield* store.getWorker(input.workerId));
      if (current !== undefined) {
        const next = yield* saveSummary(
          current,
          clearActiveActivation(current.summary, {
            status: "interrupted",
            updatedAt: interruptedAt,
            lastActivityAt: interruptedAt,
          }),
        );
        yield* publish(next, { type: "updated" });
        yield* wake({
          workerId: input.workerId,
          activationId: activation.id,
          reason: "interrupted",
          status: "interrupted",
          occurredAt: interruptedAt,
        });
      }
      return yield* read(input.workerId);
    }).pipe(Effect.mapError(mapWorkerError("worker.interrupt", "Worker interrupt failed")));

  const close: WorkerServiceShape["close"] = (workerId) =>
    Effect.gen(function* () {
      const current = Option.getOrUndefined(yield* store.getWorker(workerId));
      if (current === undefined)
        return yield* fail("worker.close", `Worker '${workerId}' was not found`);
      const activation =
        current.summary.activeActivationId === undefined
          ? undefined
          : Option.getOrUndefined(yield* store.getActivation(current.summary.activeActivationId));
      if (activation !== undefined) yield* backend.stop(activation.providerThreadId);
      const closedAt = yield* nowIso;
      if (activation !== undefined) {
        yield* store.saveActivation(
          updateActivation(activation, "interrupted", closedAt, { finishedAt: closedAt }),
        );
      }
      const next = yield* saveSummary(
        current,
        clearActiveActivation(current.summary, {
          status: "closed",
          resumable: false,
          updatedAt: closedAt,
          lastActivityAt: closedAt,
        }),
      );
      yield* publish(next, { type: "updated" });
      yield* wake({
        workerId,
        ...(activation === undefined ? {} : { activationId: activation.id }),
        reason: "closed",
        status: "closed",
        occurredAt: closedAt,
      });
      return yield* read(workerId);
    }).pipe(Effect.mapError(mapWorkerError("worker.close", "Worker close failed")));

  const respondToApproval: WorkerServiceShape["respondToApproval"] = (input) =>
    Effect.gen(function* () {
      const detail = yield* read(input.workerId);
      const approval = detail.pendingApproval;
      if (approval === undefined || approval.requestId !== input.requestId)
        return yield* fail("worker.approvalRespond", "Approval request is not pending");
      const activation = detail.activations.find((item) => item.id === approval.activationId);
      if (activation === undefined)
        return yield* fail("worker.approvalRespond", "Approval activation was not found");
      yield* backend.respondToApproval({
        providerThreadId: activation.providerThreadId,
        requestId: input.requestId,
        decision: input.decision,
      });
      const resolvedAt = yield* nowIso;
      yield* store.resolveApproval({
        requestId: input.requestId,
        decision: input.decision,
        resolvedAt,
      });
      const resolvedApproval = {
        ...approval,
        status: "resolved",
        resolvedAt,
        decision: input.decision,
      } as const;
      const message: WorkerMessage = {
        id: WorkerMessageId.make(yield* randomUuid),
        workerId: input.workerId,
        activationId: activation.id,
        author: "parent",
        kind: "approvalDecision",
        body: `Approval ${input.decision}`,
        createdAt: resolvedAt,
      };
      const current = Option.getOrUndefined(yield* store.getWorker(input.workerId));
      if (current !== undefined) {
        const runningActivation = updateActivation(activation, "running", resolvedAt);
        yield* store.saveActivation(runningActivation);
        const running = yield* saveSummary(current, {
          ...current.summary,
          status: "running",
          updatedAt: resolvedAt,
          lastActivityAt: resolvedAt,
        });
        const withDecision = yield* addMessage(running, message);
        yield* publish(withDecision, {
          type: "approvalResolved",
          approval: resolvedApproval,
        });
      }
      yield* wake({
        workerId: input.workerId,
        activationId: activation.id,
        reason: "statusChanged",
        status: "running",
        occurredAt: resolvedAt,
      });
      return yield* read(input.workerId);
    }).pipe(Effect.mapError(mapWorkerError("worker.approvalRespond", "Approval response failed")));

  const reconcileParentAfterRewind: WorkerServiceShape["reconcileParentAfterRewind"] = (input) =>
    Effect.gen(function* () {
      const [workers, parentActivities] = yield* Effect.all([
        store.listWorkers({
          parentThreadId: input.parentThreadId,
          includeClosed: true,
          includeDiscarded: false,
          limit: 100_000,
        }),
        input.parentActivities !== undefined
          ? Effect.succeed(input.parentActivities)
          : store.listParentActivities
            ? store.listParentActivities(input.parentThreadId)
            : Effect.succeed([]),
      ]);
      const historicalLineage = new Map<string, TurnId>();
      for (const activity of parentActivities) {
        const lineage = workerStartLineage(activity);
        if (lineage && !historicalLineage.has(lineage.workerId)) {
          historicalLineage.set(lineage.workerId, lineage.parentTurnId);
        }
      }

      return yield* Effect.forEach(
        workers,
        (stored) =>
          Effect.gen(function* () {
            const activations = yield* store.listActivations(stored.summary.id);
            const parentTurnId =
              stored.parentTurnId ??
              activations.find((activation) => activation.parentTurnId !== undefined)
                ?.parentTurnId ??
              historicalLineage.get(stored.summary.id);
            if (parentTurnId !== undefined && input.retainedTurnIds.has(parentTurnId)) {
              return undefined;
            }
            if (parentTurnId === undefined && !input.discardUnattributed) {
              return undefined;
            }

            const discardedAt = yield* nowIso;
            const activeActivation =
              stored.summary.activeActivationId === undefined
                ? undefined
                : activations.find(
                    (activation) => activation.id === stored.summary.activeActivationId,
                  );
            if (stored.summary.activeActivationId !== undefined && activeActivation === undefined) {
              return yield* fail(
                "worker.reconcileAfterRewind",
                `Active Worker '${stored.summary.id}' has no activation to stop`,
              );
            }
            if (activeActivation !== undefined) {
              yield* backend.stop(activeActivation.providerThreadId);
              yield* store.saveActivation(
                updateActivation(activeActivation, "interrupted", discardedAt, {
                  finishedAt: discardedAt,
                  error: "Parent task rewound before this Worker was created.",
                }),
              );
            }
            const summary =
              activeActivation === undefined
                ? stored.summary
                : clearActiveActivation(stored.summary, {
                    status: "interrupted",
                    resumable: false,
                    updatedAt: discardedAt,
                    lastActivityAt: discardedAt,
                  });
            const discarded: StoredWorker = {
              ...stored,
              ...(parentTurnId === undefined ? {} : { parentTurnId }),
              summary,
              discardedAt,
              discardedByRequestId: input.requestId,
            };
            yield* store.saveWorker(discarded);
            yield* publish(discarded, { type: "deleted" });
            if (activeActivation !== undefined) {
              yield* wake({
                workerId: stored.summary.id,
                activationId: activeActivation.id,
                reason: "interrupted",
                status: "interrupted",
                occurredAt: discardedAt,
              });
            }
            return stored.summary.id;
          }),
        { concurrency: 1 },
      ).pipe(Effect.map((workerIds) => workerIds.filter((id): id is WorkerId => id !== undefined)));
    }).pipe(
      Effect.mapError(
        mapWorkerError(
          "worker.reconcileAfterRewind",
          "Worker lineage reconciliation after rewind failed",
        ),
      ),
    );

  const handleProviderEvent: WorkerServiceShape["handleProviderEvent"] = (event) =>
    Effect.gen(function* () {
      const match = Option.getOrUndefined(yield* store.findProviderThread(event.threadId));
      if (match === undefined) return;
      const current = Option.getOrUndefined(yield* store.getWorker(match.workerId));
      if (current === undefined || current.discardedAt !== undefined) return;
      yield* store.appendProviderEvent({
        eventId: event.eventId,
        workerId: match.workerId,
        createdAt: event.createdAt,
        eventType: event.type,
        payload: event,
      });
      const activation = Option.getOrUndefined(yield* store.getActivation(match.activationId));
      if (activation === undefined) return;
      const payload = event.payload as Record<string, unknown>;
      if (
        event.type === "content.delta" &&
        payload.streamKind === "assistant_text" &&
        typeof payload.delta === "string"
      ) {
        yield* Ref.update(contentBuffers, (buffers) =>
          new Map(buffers).set(
            match.activationId,
            `${buffers.get(match.activationId) ?? ""}${payload.delta as string}`,
          ),
        );
      }
      if (event.type === "turn.started") {
        yield* store.saveActivation(
          updateActivation(
            activation,
            "running",
            event.createdAt,
            event.turnId === undefined ? {} : { providerTurnId: event.turnId },
          ),
        );
        const next = yield* saveSummary(current, {
          ...current.summary,
          status: "running",
          updatedAt: event.createdAt,
        });
        yield* publish(next, { type: "updated" });
        return;
      }
      if (event.type === "request.opened" || event.type === "user-input.requested") {
        const requestId = event.requestId;
        if (requestId === undefined) return;
        const approval = {
          requestId: ApprovalRequestId.make(requestId),
          workerId: match.workerId,
          activationId: match.activationId,
          kind: event.type === "request.opened" ? "provider-request" : "user-input",
          summary:
            typeof payload.detail === "string" ? payload.detail : "Worker is waiting for input",
          ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
          requestedAt: event.createdAt,
          status: "pending",
        } satisfies import("@t3tools/contracts").WorkerApprovalRequest;
        yield* store.saveApproval(approval);
        yield* store.saveActivation(
          updateActivation(activation, "waitingApproval", event.createdAt),
        );
        const next = yield* saveSummary(current, {
          ...current.summary,
          status: "waitingApproval",
          updatedAt: event.createdAt,
        });
        yield* publish(next, { type: "approvalRequested", approval });
        yield* wake({
          workerId: match.workerId,
          activationId: match.activationId,
          reason: "approvalRequested",
          status: "waitingApproval",
          occurredAt: event.createdAt,
        });
        return;
      }
      if (event.type === "thread.token-usage.updated") {
        const usage = payload.usage as Record<string, unknown> | undefined;
        const projected = projectWorkerUsageSnapshot(usage, event.raw);
        const lastModelCall = projected.lastModelCall ?? projected.cumulative;
        yield* store.saveActivation({
          ...activation,
          lastActivityAt: event.createdAt,
          usageDelta: lastModelCall,
        });
        yield* saveSummary(current, {
          ...current.summary,
          usage: projected.cumulative,
          usageCoverage: projected.coverage,
          lastModelCallUsage: lastModelCall,
          updatedAt: event.createdAt,
        });
        return;
      }
      if (
        event.type === "turn.completed" ||
        event.type === "turn.aborted" ||
        event.type === "runtime.error"
      ) {
        const state =
          event.type === "turn.completed"
            ? payload.state
            : event.type === "turn.aborted"
              ? "interrupted"
              : "failed";
        const status: WorkerActivation["status"] =
          state === "completed"
            ? "completed"
            : state === "interrupted" || state === "cancelled"
              ? "interrupted"
              : "failed";
        const handoff =
          status === "completed"
            ? (yield* Ref.get(contentBuffers)).get(match.activationId)?.trim() ||
              "Worker completed without a handoff."
            : undefined;
        yield* Ref.update(contentBuffers, (buffers) => {
          const next = new Map(buffers);
          next.delete(match.activationId);
          return next;
        });
        const finished = updateActivation(activation, status, event.createdAt, {
          finishedAt: event.createdAt,
          ...(handoff === undefined ? {} : { handoff }),
          ...(typeof payload.errorMessage === "string" ? { error: payload.errorMessage } : {}),
        });
        yield* store.saveActivation(finished);
        const next = yield* saveSummary(
          current,
          clearActiveActivation(current.summary, { status, updatedAt: event.createdAt }),
        );
        if (handoff !== undefined) {
          const message: WorkerMessage = {
            id: WorkerMessageId.make(yield* randomUuid),
            workerId: match.workerId,
            activationId: match.activationId,
            author: "worker",
            kind: "handoff",
            body: handoff,
            createdAt: event.createdAt,
          };
          yield* addMessage(next, message);
        } else {
          yield* publish(next, { type: "updated" });
        }
        const reason: WorkerWakeEvent["reason"] =
          status === "completed"
            ? "completed"
            : status === "interrupted"
              ? "interrupted"
              : "failed";
        yield* wake({
          workerId: match.workerId,
          activationId: match.activationId,
          reason,
          status,
          occurredAt: event.createdAt,
        });
      }
    }).pipe(Effect.catch(() => Effect.void));

  const recover = Effect.gen(function* () {
    const workers = yield* store.listWorkers({ includeClosed: false, limit: 500 });
    yield* Effect.forEach(workers, (worker) =>
      Effect.gen(function* () {
        const activationId = worker.summary.activeActivationId;
        if (activationId === undefined) return;
        const activation = Option.getOrUndefined(yield* store.getActivation(activationId));
        if (
          activation === undefined ||
          ["completed", "failed", "interrupted", "lost"].includes(activation.status)
        )
          return;
        if (yield* backend.hasLiveSession(activation.providerThreadId)) return;
        const lostAt = yield* nowIso;
        const lost = updateActivation(activation, "lost", lostAt, {
          finishedAt: lostAt,
          error: "Provider session was not recoverable after restart",
        });
        yield* store.saveActivation(lost);
        const next = yield* saveSummary(
          worker,
          clearActiveActivation(worker.summary, {
            status: "lost",
            updatedAt: lostAt,
            lastActivityAt: lostAt,
          }),
        );
        yield* publish(next, { type: "updated" });
        yield* wake({
          workerId: worker.summary.id,
          activationId: activation.id,
          reason: "failed",
          status: "lost",
          occurredAt: lostAt,
        });
      }).pipe(Effect.catch(() => Effect.void)),
    );
  }).pipe(Effect.catch(() => Effect.void));

  return {
    isLinkedProviderThread,
    start,
    list,
    get: read,
    send,
    wait,
    observe,
    interrupt,
    close,
    respondToApproval,
    reconcileParentAfterRewind,
    handleProviderEvent,
    recover,
    stream: Stream.fromPubSub(changes),
  } satisfies WorkerServiceShape;
});

export class WorkerService extends Context.Service<WorkerService, WorkerServiceShape>()(
  "t3/worker/WorkerService",
) {}

export const WorkerServiceLive = Layer.effect(WorkerService, makeWorkerService);

/** Test-only construction seam for state-transition behavior. */
export const __testing = {
  make: makeWorkerService,
  projectWorkerTokenUsage,
};
