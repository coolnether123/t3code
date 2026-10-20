import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  ProviderRuntimeEvent,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  type ProviderInterruptTurnInput,
  type ProviderStopSessionInput,
  type ProviderRespondToRequestInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";

export class AuxiliarySessionError extends Schema.TaggedError<AuxiliarySessionError>()(
  "AuxiliarySessionError",
  { operation: Schema.String, threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return `Could not ${this.operation} the auxiliary provider session.`;
  }
}

const isAuxiliarySessionError = Schema.is(AuxiliarySessionError);

// Calls retain their own durable records while using the shared V2 adapters.
export class AuxiliaryProviderSessions extends Context.Service<
  AuxiliaryProviderSessions,
  {
    readonly startSession: (
      threadId: ThreadId,
      input: ProviderSessionStartInput,
      owningThreadId?: ThreadId,
    ) => Effect.Effect<ProviderSession, AuxiliarySessionError>;
    readonly sendTurn: (
      input: ProviderSendTurnInput,
    ) => Effect.Effect<ProviderTurnStartResult, AuxiliarySessionError>;
    readonly interruptTurn: (
      input: ProviderInterruptTurnInput,
    ) => Effect.Effect<void, AuxiliarySessionError>;
    readonly stopSession: (input: ProviderStopSessionInput) => Effect.Effect<void>;
    readonly respondToRequest: (
      input: ProviderRespondToRequestInput,
    ) => Effect.Effect<void, AuxiliarySessionError>;
    readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
    readonly getInstanceInfo: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<
      { readonly driverKind: ProviderAdapter.ProviderAdapterV2["Service"]["driver"] },
      ProviderAdapterRegistry.ProviderAdapterRegistryV2Error
    >;
    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
    readonly streamAdapterEvents: Stream.Stream<{
      readonly threadId: ThreadId;
      readonly event: ProviderAdapter.ProviderAdapterV2Event;
    }>;
  }
>()("t3/provider/AuxiliaryProviderSessions") {}

interface Session {
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly scope: Scope.Closeable;
  readonly input: ProviderSessionStartInput;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly texts: Map<string, string>;
  providerThread: OrchestrationV2ProviderThread;
  status: ProviderSession["status"];
  turnId: TurnId | undefined;
  runId: RunId | undefined;
  ordinal: number;
  pending: Deferred.Deferred<TurnId, AuxiliarySessionError> | undefined;
  createdAt: string;
}

const make = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const crypto = yield* Crypto.Crypto;
  const ownerScope = yield* Scope.Scope;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const adapterEvents = yield* PubSub.unbounded<{
    readonly threadId: ThreadId;
    readonly event: ProviderAdapter.ProviderAdapterV2Event;
  }>();
  const sessions = new Map<ThreadId, Session>();
  const lock = yield* Semaphore.make(1);
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
  const decodeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEvent);
  const sessionView = (threadId: ThreadId, session: Session): ProviderSession => ({
    provider: session.runtime.driver,
    providerInstanceId: session.runtime.instanceId,
    threadId,
    status: session.status,
    runtimeMode: session.input.runtimeMode,
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
    ...(session.input.cwd === undefined ? {} : { cwd: session.input.cwd }),
    model: session.modelSelection.model,
    ...(session.turnId === undefined ? {} : { activeTurnId: session.turnId }),
    resumeCursor: { threadId: session.providerThread.nativeThreadRef?.nativeId },
  });
  const requireSession = (threadId: ThreadId, operation: string) => {
    const session = sessions.get(threadId);
    return session === undefined
      ? Effect.fail(new AuxiliarySessionError({ operation, threadId }))
      : Effect.succeed(session);
  };
  const emit = Effect.fn("AuxiliaryProviderSessions.emit")(function* (
    threadId: ThreadId,
    session: Session,
    body: Readonly<Record<string, unknown>>,
  ) {
    const event = yield* decodeEvent({
      eventId: EventId.make(yield* uuid),
      threadId,
      provider: session.runtime.driver,
      providerInstanceId: session.runtime.instanceId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      ...(session.turnId === undefined ? {} : { turnId: session.turnId }),
      ...body,
    }).pipe(Effect.orDie);
    yield* PubSub.publish(events, event);
  });
  const ingest = Effect.fn("AuxiliaryProviderSessions.ingest")(function* (
    threadId: ThreadId,
    session: Session,
    event: ProviderAdapter.ProviderAdapterV2Event,
  ) {
    yield* PubSub.publish(adapterEvents, { threadId, event });
    if (event.type === "provider_thread.updated") {
      session.providerThread = event.providerThread;
    } else if (event.type === "provider_turn.updated") {
      session.turnId = TurnId.make(event.providerTurn.id);
      if (session.pending !== undefined) {
        yield* Deferred.succeed(session.pending, session.turnId);
        session.pending = undefined;
      }
      if (event.providerTurn.status === "running") {
        session.status = "running";
        yield* emit(threadId, session, { type: "turn.started", payload: {} });
      }
    } else if (event.type === "message.updated" && event.message.role === "assistant") {
      const previous = session.texts.get(event.message.id) ?? "";
      const delta = event.message.text.startsWith(previous)
        ? event.message.text.slice(previous.length)
        : event.message.text;
      session.texts.set(event.message.id, event.message.text);
      if (delta)
        yield* emit(threadId, session, {
          type: "content.delta",
          itemId: event.message.id,
          payload: { streamKind: "assistant_text", delta },
        });
      if (!event.message.streaming && event.message.text) {
        yield* emit(threadId, session, {
          type: "item.completed",
          itemId: event.message.id,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            detail: event.message.text,
          },
        });
      }
    } else if (event.type === "turn_item.updated" && event.turnItem.status === "waiting") {
      const item = event.turnItem;
      if (item.type === "approval_request") {
        yield* emit(threadId, session, {
          type: "request.opened",
          requestId: item.requestId,
          payload: {
            requestType:
              item.requestKind === "file-change"
                ? "file_change_approval"
                : item.requestKind === "permission"
                  ? "permission_approval"
                  : "command_execution_approval",
            detail: item.prompt || item.title || `Approve ${item.appName || item.requestKind}`,
            ...(item.appName ? { appName: item.appName } : {}),
            ...(item.options ? { options: item.options } : {}),
          },
        });
      } else if (item.type === "user_input_request") {
        yield* emit(threadId, session, {
          type: "user-input.requested",
          requestId: item.requestId,
          payload: {
            questions: item.questions,
            ...(item.responseMode ? { responseMode: item.responseMode } : {}),
          },
        });
      }
    } else if (event.type === "turn.terminal") {
      session.status = "ready";
      session.turnId = TurnId.make(event.providerTurnId);
      yield* emit(threadId, session, {
        type: "turn.completed",
        payload: {
          state: event.status,
          ...(event.failure === null ? {} : { errorMessage: event.failure.message }),
        },
      });
    }
  });

  const stopSession = Effect.fn("AuxiliaryProviderSessions.stopSession")(function* ({
    threadId,
  }: ProviderStopSessionInput) {
    const session = sessions.get(threadId);
    if (session === undefined) return;
    sessions.delete(threadId);
    if (session.pending !== undefined)
      yield* Deferred.fail(
        session.pending,
        new AuxiliarySessionError({ operation: "start a turn in", threadId }),
      );
    yield* Scope.close(session.scope, Exit.void);
    yield* manager.close(session.runtime.providerSessionId).pipe(Effect.ignoreCause({ log: true }));
  });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.keys()], (threadId) => stopSession({ threadId }), {
      discard: true,
    }),
  );

  return AuxiliaryProviderSessions.of({
    streamEvents: Stream.fromPubSub(events),
    streamAdapterEvents: Stream.fromPubSub(adapterEvents),
    getInstanceInfo: (instanceId) =>
      registry.get(instanceId).pipe(Effect.map((adapter) => ({ driverKind: adapter.driver }))),
    listSessions: () =>
      Effect.forEach([...sessions], ([id, session]) =>
        Effect.gen(function* () {
          if (!(yield* manager.isLive(session.runtime.providerSessionId)))
            session.status = "closed";
          return sessionView(id, session);
        }),
      ),
    stopSession,
    startSession: (threadId, input, owningThreadId) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* stopSession({ threadId });
          const modelSelection = input.modelSelection;
          if (modelSelection === undefined)
            return yield* new AuxiliarySessionError({ operation: "select a model for", threadId });
          const adapter = yield* registry.get(
            input.providerInstanceId ?? modelSelection.instanceId,
          );
          if (input.toolMode === "none" && adapter.driver !== "claudeAgent") {
            return yield* new AuxiliarySessionError({
              operation: "open a tool-free conversation with this provider in",
              threadId,
            });
          }
          const scope = yield* Scope.fork(ownerScope, "sequential");
          const runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy = {
            cwd: input.cwd ?? null,
            runtimeMode: input.runtimeMode,
            interactionMode: "default",
            ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
            ...(input.sandboxMode === undefined ? {} : { sandboxPolicy: input.sandboxMode }),
            ...(input.toolMode === undefined ? {} : { toolMode: input.toolMode }),
            isolated: true,
          };
          const runtime = yield* manager.open({
            threadId,
            ...(owningThreadId === undefined ? {} : { owningThreadId }),
            providerSessionId: ProviderSessionId.make(yield* uuid),
            modelSelection,
            runtimePolicy,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
            ...(input.title === undefined ? {} : { title: input.title }),
          });
          const session: Session = {
            runtime,
            scope,
            input,
            modelSelection,
            runtimePolicy,
            providerThread,
            status: "ready",
            texts: new Map(),
            turnId: undefined,
            runId: undefined,
            ordinal: 0,
            pending: undefined,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          };
          sessions.set(threadId, session);
          const subscription =
            runtime.subscribeEvents === undefined ? undefined : yield* runtime.subscribeEvents;
          if (subscription !== undefined)
            yield* Effect.addFinalizer(() => subscription.close).pipe(
              Effect.provideService(Scope.Scope, scope),
            );
          yield* (subscription?.events ?? runtime.events).pipe(
            Stream.runForEach((event) => ingest(threadId, session, event)),
            Effect.andThen(
              Effect.fail(new AuxiliarySessionError({ operation: "read events from", threadId })),
            ),
            Effect.catch((cause) =>
              Effect.gen(function* () {
                session.status = "error";
                const error = new AuxiliarySessionError({
                  operation: "read events from",
                  threadId,
                  cause,
                });
                if (session.pending !== undefined) yield* Deferred.fail(session.pending, error);
                session.pending = undefined;
                yield* emit(threadId, session, {
                  type: "runtime.error",
                  payload: { message: error.message },
                });
              }),
            ),
            Effect.forkIn(scope),
          );
          return sessionView(threadId, session);
        }).pipe(
          Effect.mapError((cause) =>
            isAuxiliarySessionError(cause)
              ? cause
              : new AuxiliarySessionError({ operation: "open", threadId, cause }),
          ),
        ),
      ),
    sendTurn: (input) =>
      Effect.gen(function* () {
        const session = yield* requireSession(input.threadId, "start a turn in");
        if (session.status !== "ready")
          return yield* new AuxiliarySessionError({
            operation: "start a turn in an unavailable",
            threadId: input.threadId,
          });
        const modelSelection = input.modelSelection ?? session.modelSelection;
        const now = yield* DateTime.now;
        const appThread: OrchestrationV2AppThread = {
          id: input.threadId,
          projectId: ProjectId.make("auxiliary"),
          title: session.input.title ?? "Auxiliary session",
          providerInstanceId: session.runtime.instanceId,
          modelSelection,
          runtimeMode: session.input.runtimeMode,
          interactionMode: input.interactionMode ?? "default",
          branch: null,
          worktreePath: session.input.cwd ?? null,
          activeProviderThreadId: session.providerThread.id,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: input.threadId,
          },
          forkedFrom: null,
          createdBy: "system",
          creationSource: "server",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        const pending = yield* Deferred.make<TurnId, AuxiliarySessionError>();
        session.pending = pending;
        session.turnId = undefined;
        session.status = "running";
        session.ordinal += 1;
        session.runId = RunId.make(yield* uuid);
        yield* session.runtime
          .startTurn({
            threadId: input.threadId,
            appThread,
            runId: session.runId,
            runOrdinal: session.ordinal,
            providerTurnOrdinal: session.ordinal,
            attemptId: RunAttemptId.make(yield* uuid),
            rootNodeId: NodeId.make(yield* uuid),
            providerThread: session.providerThread,
            modelSelection,
            runtimePolicy: session.runtimePolicy,
            message: {
              messageId: MessageId.make(input.messageId ?? (yield* uuid)),
              text: input.input ?? "",
              attachments: [],
              createdBy: "system",
              creationSource: "server",
            },
          })
          .pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                if (session.pending !== pending) return;
                session.pending = undefined;
                session.status = "ready";
              }),
            ),
          );
        const turnId = yield* Deferred.await(pending);
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: { threadId: session.providerThread.nativeThreadRef?.nativeId },
        };
      }).pipe(
        Effect.mapError((cause) =>
          isAuxiliarySessionError(cause)
            ? cause
            : new AuxiliarySessionError({
                operation: "start a turn in",
                threadId: input.threadId,
                cause,
              }),
        ),
      ),
    interruptTurn: (input) =>
      Effect.gen(function* () {
        const session = yield* requireSession(input.threadId, "interrupt");
        if (session.turnId === undefined) return;
        yield* session.runtime.interruptTurn({
          providerThread: session.providerThread,
          providerTurnId: ProviderTurnId.make(input.turnId ?? session.turnId),
        });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AuxiliarySessionError({ operation: "interrupt", threadId: input.threadId, cause }),
        ),
      ),
    respondToRequest: (input) =>
      Effect.gen(function* () {
        const session = yield* requireSession(input.threadId, "answer an approval in");
        yield* session.runtime.respondToRuntimeRequest({
          requestId: RuntimeRequestId.make(input.requestId),
          decision: input.decision,
        });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AuxiliarySessionError({
              operation: "answer an approval in",
              threadId: input.threadId,
              cause,
            }),
        ),
      ),
  });
});

export const layer = Layer.effect(AuxiliaryProviderSessions, make);
