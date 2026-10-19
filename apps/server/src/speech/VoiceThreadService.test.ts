import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  OrchestrationV2AppThread,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
    });
    expect(projection.turnItems).toHaveLength(1);
    expect(projection.turnItems[0]).toMatchObject({
      type: "assistant_message",
      status: "completed",
      text: "Hello there",
    });
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
