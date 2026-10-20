import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  RunId,
  TurnItemId,
  EventId,
  OrchestrationV2AppThread,
  ProviderRuntimeEvent,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Cause from "effect/Cause";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Auxiliary from "../provider/AuxiliaryProviderSessions.ts";
import * as VoiceThreadService from "./VoiceThreadService.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const now = "2026-10-19T06:00:00.000Z";
const thread = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2AppThread))({
  id: "synthetic-voice-thread",
  projectId: "synthetic-project",
  title: "Voice fixture",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    rootThreadId: "synthetic-voice-thread",
    parentThreadId: null,
    relationshipToParent: null,
  },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
});
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const dependencies = Layer.mergeAll(
  EventSink.layer.pipe(Layer.provideMerge(stores)),
  ThreadCommandExecutor.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-service-test-" }),
  Layer.mock(Auxiliary.AuxiliaryProviderSessions)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
);
const layer = VoiceThreadService.layer.pipe(
  Layer.provideMerge(dependencies),
  Layer.provide(NodeServices.layer),
);
const seed = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  yield* sink.write({
    events: [
      {
        id: EventId.make("synthetic-create"),
        type: "thread.created",
        threadId: thread.id,
        occurredAt: DateTime.makeUnsafe(now),
        payload: thread,
      },
    ],
  });
  return yield* VoiceThreadService.VoiceThreadService;
});

it.effect.each(["session", "turn"] as const)(
  "answers an operator %s approval through the event pump and preserves typed chat routing",
  (requestScope) =>
    Effect.gen(function* () {
      const continued = yield* Deferred.make<void>();
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
      let finishOperator: Effect.Effect<void> = Effect.void;
      const sessionId = ProviderSessionId.make("synthetic-operator-session");
      const requestId = RuntimeRequestId.make("synthetic-operator-approval");
      const nodeId = NodeId.make("synthetic-operator-node");
      const link = {
        sessionId: "t3-call-operator-synthetic",
        threadId: thread.id,
        role: "operator" as const,
        selection: thread.modelSelection,
      };
      const timestamp = DateTime.makeUnsafe(now);
      const providerThread = {
        id: ProviderThreadId.make("synthetic-operator-provider-thread"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: thread.providerInstanceId,
        providerSessionId: sessionId,
        appThreadId: ThreadId.make(link.sessionId),
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const providerTurn = {
        id: ProviderTurnId.make("synthetic-operator-turn"),
        providerThreadId: ProviderThreadId.make("synthetic-operator-provider-thread"),
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: timestamp,
        completedAt: null,
      };
      const node = {
        id: nodeId,
        threadId: ThreadId.make(link.sessionId),
        runId: requestScope === "session" ? null : RunId.make("auxiliary-run"),
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "approval_request" as const,
        status: "waiting" as const,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: timestamp,
        completedAt: null,
      };
      const adapter = ProviderAdapter.ProviderAdapterV2.of({
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () =>
          Effect.succeed({
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            providerSessionId: sessionId,
            providerSession: {
              id: sessionId,
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              status: "ready",
              cwd: process.cwd(),
              model: "gpt-5.4",
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: timestamp,
              updatedAt: timestamp,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: () =>
              Effect.gen(function* () {
                yield* Queue.offerAll(events, [
                  { type: "node.updated", driver: providerThread.driver, node },
                  { type: "provider_turn.updated", driver: providerThread.driver, providerTurn },
                  {
                    type: "turn_item.updated",
                    driver: providerThread.driver,
                    turnItem: {
                      type: "approval_request",
                      id: TurnItemId.make("operator-approval-item"),
                      threadId: node.threadId,
                      runId: node.runId,
                      nodeId,
                      providerThreadId: providerThread.id,
                      providerTurnId: requestScope === "session" ? null : providerTurn.id,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 1,
                      status: "waiting",
                      title: null,
                      startedAt: timestamp,
                      completedAt: null,
                      updatedAt: timestamp,
                      requestId,
                      requestKind: "command",
                    },
                  },
                  {
                    type: "runtime_request.updated",
                    driver: providerThread.driver,
                    threadId: node.threadId,
                    runtimeRequest: {
                      id: requestId,
                      nodeId,
                      providerTurnId: requestScope === "session" ? null : providerTurn.id,
                      nativeRequestRef: null,
                      kind: "command",
                      status: "pending",
                      responseCapability: { type: "live", providerSessionId: sessionId },
                      createdAt: timestamp,
                      resolvedAt: null,
                    },
                  },
                ]);
                yield* Deferred.await(continued);
                return providerThread;
              }),
            resumeThread: () => Effect.die("unused"),
            startTurn: () => Effect.void,
            steerTurn: () => Effect.void,
            interruptTurn: () => Effect.void,
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
            respondToRuntimeRequest: (input) =>
              Effect.gen(function* () {
                expect(input).toEqual({ requestId, decision: "accept" });
                yield* finishOperator;
                yield* Deferred.succeed(continued, undefined);
              }),
          }),
      });
      const database = Sqlite.layerMemory;
      const runtime = ProviderReplayHarness.layerWithRegistry(
        { name: "operator-approval" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: database, runEffectWorker: false },
      );
      const testDependencies = Layer.mergeAll(
        runtime,
        stores,
        ThreadCommandExecutor.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "operator-approval-" }),
        Layer.mock(Auxiliary.AuxiliaryProviderSessions)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* seed;
        finishOperator = Queue.offerAll(events, [
          {
            type: "node.updated",
            driver: ProviderDriverKind.make("codex"),
            node: { ...node, status: "completed", completedAt: timestamp },
          },
          {
            type: "provider_turn.updated",
            driver: ProviderDriverKind.make("codex"),
            providerTurn: { ...providerTurn, status: "completed", completedAt: timestamp },
          },
        ]).pipe(Effect.asVoid);
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const operatorRuntime = yield* manager.open({
          threadId: ThreadId.make(link.sessionId),
          owningThreadId: thread.id,
          providerSessionId: sessionId,
          modelSelection: thread.modelSelection,
          runtimePolicy: {
            cwd: null,
            runtimeMode: "approval-required",
            interactionMode: "default",
            isolated: true,
          },
        });
        expect(
          (yield* Effect.exit(
            manager.open({
              threadId: thread.id,
              providerSessionId: sessionId,
              modelSelection: thread.modelSelection,
              runtimePolicy: {
                cwd: null,
                runtimeMode: "approval-required",
                interactionMode: "default",
              },
            }),
          ))._tag,
        ).toBe("Failure");
        const bridge = operatorRuntime.events.pipe(
          Stream.runForEach((event) => service.recordOperatorEvent(link, event)),
        );
        if (requestScope === "turn")
          yield* bridge.pipe(Effect.forkScoped({ startImmediately: true }));
        const sink = yield* EventSink.EventSinkV2;
        const sequence = yield* sink.latestSequence({ threadId: thread.id });
        const pending = yield* sink.stream({ threadId: thread.id, afterSequence: sequence }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "runtime-request.updated" &&
              stored.event.payload.status === "pending",
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const starting = yield* operatorRuntime
          .ensureThread({
            threadId: node.threadId,
            modelSelection: thread.modelSelection,
            runtimePolicy: {
              cwd: null,
              runtimeMode: "approval-required",
              interactionMode: "default",
              isolated: true,
            },
          })
          .pipe(Effect.forkScoped);
        yield* Fiber.join(pending);
        if (requestScope === "session")
          yield* bridge.pipe(Effect.forkScoped({ startImmediately: true }));
        const waiting = (yield* service.snapshot(thread.id)).projection;
        expect(waiting.turnItems.find((item) => item.type === "approval_request")?.status).toBe(
          "waiting",
        );
        const completed = yield* sink.stream({ threadId: thread.id, afterSequence: sequence }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("answer-operator"),
          threadId: thread.id,
          requestId,
          decision: "accept",
        });
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain();
        yield* Fiber.join(starting);
        yield* Fiber.join(completed);
        expect(yield* Deferred.isDone(continued)).toBe(true);
        const { projection } = yield* service.snapshot(thread.id);
        expect(projection.runtimeRequests[0]?.status).toBe("resolved");
        expect(projection.nodes[0]?.status).toBe("completed");
        expect(projection.providerTurns[0]?.status).toBe("completed");

        const chatProviderThread = {
          id: ProviderThreadId.make("chat-provider-thread"),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: thread.providerInstanceId,
          providerSessionId: ProviderSessionId.make("chat-provider-session"),
          appThreadId: thread.id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("chat-provider-thread-created"),
              type: "provider-thread.updated",
              threadId: thread.id,
              occurredAt: timestamp,
              payload: chatProviderThread,
            },
          ],
        });
        yield* service.recordOperatorEvent(link, {
          type: "provider_thread.updated",
          driver: chatProviderThread.driver,
          providerThread: {
            ...chatProviderThread,
            id: providerTurn.providerThreadId,
            providerSessionId: sessionId,
            appThreadId: ThreadId.make(link.sessionId),
          },
        });
        expect((yield* service.snapshot(thread.id)).projection.thread.activeProviderThreadId).toBe(
          chatProviderThread.id,
        );
        yield* service.recordVoiceEvent(
          { ...link, sessionId: "t3-call-voice-synthetic", role: "voice" },
          decodeRuntimeEvent({
            type: "turn.completed",
            eventId: "voice-before-typed",
            provider: "codex",
            threadId: thread.id,
            turnId: "voice-before-typed",
            createdAt: now,
            payload: { state: "completed" },
          }),
          "Ready for your next message.",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("typed-after-call"),
          threadId: thread.id,
          messageId: MessageId.make("typed-after-call"),
          text: "Continue in this chat",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "defer_start" },
        });
        const afterCall = (yield* service.snapshot(thread.id)).projection;
        expect(afterCall.runs.at(-1)?.providerThreadId).toBe(chatProviderThread.id);
        expect(
          afterCall.providerThreads.find((candidate) => candidate.id === chatProviderThread.id)
            ?.providerSessionId,
        ).toBe(chatProviderThread.providerSessionId);
        yield* manager.close(sessionId);
      }).pipe(
        Effect.provide(
          VoiceThreadService.layer.pipe(
            Layer.provideMerge(testDependencies),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    }),
);

it.effect("updates one durable voice reply and removes call-control markup", () =>
  Effect.gen(function* () {
    const service = yield* seed;
    const link = {
      sessionId: "synthetic-voice",
      threadId: thread.id,
      role: "voice" as const,
      selection: thread.modelSelection,
    };
    const event = decodeRuntimeEvent({
      type: "content.delta",
      eventId: "synthetic-delta",
      provider: "codex",
      threadId: thread.id,
      turnId: "synthetic-turn",
      createdAt: now,
      payload: { streamKind: "assistant_text", delta: "Hello" },
    });
    yield* service.recordVoiceEvent(link, event, "Hello");
    const active = (yield* service.snapshot(thread.id)).projection;
    expect(active.messages[0]?.runId).toBe("synthetic-turn");
    expect(active.messages[0]?.streaming).toBe(true);
    const completed = decodeRuntimeEvent({
      type: "turn.completed",
      eventId: "synthetic-complete",
      provider: "codex",
      threadId: thread.id,
      turnId: "synthetic-turn",
      createdAt: now,
      payload: { state: "completed" },
    });
    yield* service.recordVoiceEvent(
      link,
      completed,
      "Hello there<otis-status>private control</otis-status>",
    );
    const { projection } = yield* service.snapshot(thread.id);
    expect(projection.messages).toHaveLength(1);
    expect(projection.messages[0]).toMatchObject({
      text: "Hello there",
      streaming: false,
      role: "assistant",
      runId: "synthetic-turn",
    });
    expect(projection.turnItems).toHaveLength(1);
    expect(projection.turnItems[0]).toMatchObject({
      type: "assistant_message",
      status: "completed",
      text: "Hello there",
      runId: "synthetic-turn",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves delegation intent for the client without exposing control blocks", () =>
  Effect.gen(function* () {
    const service = yield* seed;
    yield* service.recordVoiceEvent(
      {
        sessionId: "delegating-voice",
        threadId: thread.id,
        role: "voice",
        selection: thread.modelSelection,
      },
      decodeRuntimeEvent({
        type: "turn.completed",
        eventId: "delegate-completed",
        provider: "codex",
        threadId: thread.id,
        turnId: "delegate-turn",
        createdAt: now,
        payload: { state: "completed" },
      }),
      '<otis-hold/><otis-delegate>{"intent":"Check"}</otis-delegate>',
    );
    const { projection } = yield* service.snapshot(thread.id);
    expect(projection.messages[0]).toMatchObject({
      text: "",
      streaming: false,
      voiceDelegation: true,
    });
    expect(projection.turnItems[0]).toMatchObject({ status: "completed", text: "" });
  }).pipe(Effect.provide(layer)),
);

it.effect("records a silent hold as completed without speaking its control marker", () =>
  Effect.gen(function* () {
    const service = yield* seed;
    yield* service.recordVoiceEvent(
      {
        sessionId: "silent-voice",
        threadId: thread.id,
        role: "voice",
        selection: thread.modelSelection,
      },
      decodeRuntimeEvent({
        type: "turn.completed",
        eventId: "hold-completed",
        provider: "codex",
        threadId: thread.id,
        turnId: "hold-turn",
        createdAt: now,
        payload: { state: "completed" },
      }),
      "<otis-hold/>",
    );
    const { projection } = yield* service.snapshot(thread.id);
    expect(projection.messages[0]).toMatchObject({ text: "", streaming: false });
    expect(projection.turnItems[0]).toMatchObject({ status: "completed", text: "" });
  }).pipe(Effect.provide(layer)),
);

it.effect("shows an active voice reply before text arrives and clears it after failure", () =>
  Effect.gen(function* () {
    const service = yield* seed;
    const link = {
      sessionId: "synthetic-voice",
      threadId: thread.id,
      role: "voice" as const,
      selection: thread.modelSelection,
    };
    yield* service.recordVoiceEvent(
      link,
      decodeRuntimeEvent({
        type: "turn.started",
        eventId: "voice-started",
        provider: "codex",
        threadId: thread.id,
        turnId: "voice-empty-turn",
        createdAt: now,
        payload: {},
      }),
      "",
    );
    expect((yield* service.snapshot(thread.id)).projection.messages[0]).toMatchObject({
      runId: "voice-empty-turn",
      streaming: true,
    });
    yield* service.recordVoiceEvent(
      link,
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "voice-failed",
        provider: "codex",
        threadId: thread.id,
        turnId: "voice-empty-turn",
        createdAt: now,
        payload: { message: "Synthetic stream failure" },
      }),
      "",
    );
    const { projection } = yield* service.snapshot(thread.id);
    expect(projection.messages[0]).toMatchObject({ runId: "voice-empty-turn", streaming: false });
  }).pipe(Effect.provide(layer)),
);

it.effect("records call activity once with its durable metadata", () =>
  Effect.gen(function* () {
    const service = yield* seed;
    const command = {
      type: "thread.activity.append" as const,
      commandId: CommandId.make("synthetic-activity"),
      threadId: thread.id,
      createdAt: now,
      activity: {
        id: EventId.make("synthetic-activity-item"),
        kind: "call.started",
        summary: "Call started",
        tone: "info" as const,
        payload: { callId: "synthetic-call" },
        turnId: null,
        createdAt: now,
      },
    };
    yield* service.dispatch(command);
    yield* service.dispatch(command);
    const { projection } = yield* service.snapshot(thread.id);
    expect(projection.turnItems).toHaveLength(1);
    expect(projection.turnItems[0]).toMatchObject({
      type: "system_notice",
      message: "Call started",
      activity: { kind: "call.started", payload: { callId: "synthetic-call" } },
    });
  }).pipe(Effect.provide(layer)),
);
