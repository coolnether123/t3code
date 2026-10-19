import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
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

it.effect("answers an operator approval in its visible chat and continues to completion", () =>
  Effect.gen(function* () {
    const continued = yield* Deferred.make<void>();
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
      runId: null,
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
          events: Stream.never,
          ensureThread: () => Effect.die("unused"),
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
      finishOperator = service
        .recordOperatorEvent(link, {
          type: "node.updated",
          driver: ProviderDriverKind.make("codex"),
          node: { ...node, status: "completed", completedAt: timestamp },
        })
        .pipe(
          Effect.andThen(
            service.recordOperatorEvent(link, {
              type: "provider_turn.updated",
              driver: ProviderDriverKind.make("codex"),
              providerTurn: { ...providerTurn, status: "completed", completedAt: timestamp },
            }),
          ),
          Effect.orDie,
        );
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      yield* manager.open({
        threadId: ThreadId.make(link.sessionId),
        owningThreadId: thread.id,
        providerSessionId: sessionId,
        modelSelection: thread.modelSelection,
        runtimePolicy: { cwd: null, runtimeMode: "approval-required", interactionMode: "default" },
      });
      yield* service.recordOperatorEvent(link, {
        type: "node.updated",
        driver: ProviderDriverKind.make("codex"),
        node,
      });
      yield* service.recordOperatorEvent(link, {
        type: "provider_turn.updated",
        driver: ProviderDriverKind.make("codex"),
        providerTurn,
      });
      yield* service.recordOperatorEvent(link, {
        type: "runtime_request.updated",
        driver: ProviderDriverKind.make("codex"),
        runtimeRequest: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: sessionId },
          createdAt: timestamp,
          resolvedAt: null,
        },
      });
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
      expect(yield* Deferred.isDone(continued)).toBe(true);
      const { projection } = yield* service.snapshot(thread.id);
      expect(projection.runtimeRequests[0]?.status).toBe("resolved");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.providerTurns[0]?.status).toBe("completed");
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
        type: "turn.completed",
        eventId: "voice-failed",
        provider: "codex",
        threadId: thread.id,
        turnId: "voice-empty-turn",
        createdAt: now,
        payload: { state: "failed" },
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
