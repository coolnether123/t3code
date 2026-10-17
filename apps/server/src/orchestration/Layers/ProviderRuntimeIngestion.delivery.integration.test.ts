// @effect-diagnostics nodeBuiltinImport:off
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RuntimeRepository from "../../persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as WorkerService from "../../worker/WorkerService.ts";
import * as ProviderAdapterRegistry from "../../provider/Services/ProviderAdapterRegistry.ts";
import type { ProviderAdapterShape } from "../../provider/Services/ProviderAdapter.ts";
import { makeAdapterRegistryMock } from "../../provider/testUtils/providerAdapterRegistryMock.ts";
import { makeProviderServiceLive } from "../../provider/Layers/ProviderService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { ServerActivation } from "../../serverActivation.ts";

it.effect.each([
  { gated: false, failure: "none" },
  { gated: true, failure: "none" },
  { gated: false, failure: "interrupt" },
  { gated: false, failure: "defect" },
  { gated: false, failure: "partial-write" },
  { gated: false, failure: "shutdown" },
] as const)("delivers root updates and isolates event failures with %j", ({ gated, failure }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const completedSeen = yield* Deferred.make<void>();
      const activation = yield* Deferred.make<void>();
      const interruptedWorker = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const processingStopped = yield* Deferred.make<void>();
      const allInputsObserved = yield* Deferred.make<void>();
      const logs: string[] = [];
      let linkedChecks = 0;
      let partialWrite = Effect.void;
      const unsupported = () => Effect.die("Not used in synthetic diagnostic");
      const adapter: ProviderAdapterShape<never> = {
        provider: ProviderDriverKind.make("codex"),
        capabilities: { sessionModelSwitch: "in-session" },
        startSession: unsupported,
        sendTurn: unsupported,
        interruptTurn: unsupported,
        respondToRequest: unsupported,
        respondToUserInput: unsupported,
        stopSession: unsupported,
        listSessions: () => Effect.succeed([]),
        hasSession: () => Effect.succeed(false),
        readThread: unsupported,
        rollbackThread: unsupported,
        stopAll: () => Effect.void,
        get streamEvents() {
          return Stream.fromQueue(queue);
        },
      };
      const workerService = WorkerService.WorkerService.of({
        start: unsupported,
        list: unsupported,
        get: unsupported,
        send: unsupported,
        wait: unsupported,
        observe: unsupported,
        interrupt: unsupported,
        close: unsupported,
        respondToApproval: unsupported,
        reconcileParentAfterRewind: unsupported,
        handleProviderEvent: () => Effect.void,
        recover: Effect.void,
        stream: Stream.empty,
        isLinkedProviderThread: () =>
          Effect.gen(function* () {
            linkedChecks += 1;
            if (linkedChecks === 4) yield* Deferred.succeed(allInputsObserved, undefined);
            if (linkedChecks !== 1 || failure === "none") return false;
            if (failure === "shutdown") {
              return yield* Effect.gen(function* () {
                yield* Deferred.succeed(interruptedWorker, yield* Effect.fiber);
                return yield* Effect.never;
              }).pipe(Effect.ensuring(Deferred.succeed(processingStopped, undefined)));
            }
            yield* Deferred.succeed(interruptedWorker, yield* Effect.fiber);
            if (failure === "partial-write") yield* partialWrite;
            if (failure === "defect") return yield* Effect.die("Injected processing defect");
            return yield* Effect.interrupt;
          }),
      });
      const config = ServerConfig.layerTest(process.cwd(), process.cwd());
      const settings = ServerSettingsService.layerTest();
      const directory = ProviderSessionDirectoryLive.pipe(
        Layer.provide(RuntimeRepository.layer),
        Layer.provide(SqlitePersistenceMemory),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(
            ProviderAdapterRegistry.ProviderAdapterRegistry,
            makeAdapterRegistryMock({ [ProviderDriverKind.make("codex")]: adapter }),
          ),
        ),
        Layer.provide(directory),
        Layer.provide(settings),
        Layer.provide(config),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );
      const snapshot = OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
      );
      const engineLayer = OrchestrationEngineLive.pipe(
        Layer.provide(snapshot),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
      );
      const runtimeScope = yield* Effect.acquireRelease(Scope.make("sequential"), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const context = yield* Layer.buildWithScope(
        ProviderRuntimeIngestionLive.pipe(
          Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(engineLayer),
          Layer.provideMerge(snapshot),
          Layer.provideMerge(ThreadBackgroundLiveness.layer),
          Layer.provideMerge(ThreadPlanProgress.layer),
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provideMerge(providerLayer),
          Layer.provideMerge(settings),
          Layer.provideMerge(config),
          Layer.provideMerge(Layer.succeed(WorkerService.WorkerService, workerService)),
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(Logger.layer([Logger.make(({ message }) => logs.push(String(message)))])),
        ),
        runtimeScope,
      );
      const run = Effect.provide(context);
      const scope = yield* Effect.acquireRelease(Scope.make("sequential"), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const engine = yield* run(Effect.service(OrchestrationEngineService));
      const ingestion = yield* run(Effect.service(ProviderRuntimeIngestionService));
      const query = yield* run(Effect.service(ProjectionSnapshotQuery));
      // Startup is invoked by a short-lived caller, not the scope owner.
      yield* Fiber.join(
        yield* Effect.forkChild(
          run(
            ingestion
              .start()
              .pipe(
                Scope.provide(scope),
                Effect.provideService(
                  ServerActivation,
                  gated ? Deferred.await(activation) : undefined,
                ),
              ),
          ),
        ),
      );
      const threadId = ThreadId.make("1af5efe0-8578-4e9c-85a6-49cb0417ffd3");
      const turnId = TurnId.make("01a14851-971e-7ed0-b689-b075d3cf5963");
      const projectId = ProjectId.make("synthetic-root-projection");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
      const createdAt = "2026-10-17T05:24:22.620Z";
      yield* run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project"),
          projectId,
          title: "Synthetic",
          workspaceRoot: process.cwd(),
          defaultModelSelection: modelSelection,
          createdAt,
        }),
      );
      partialWrite = engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("partial-side-effect"),
          threadId,
          activity: {
            id: EventId.make("partial-side-effect"),
            kind: "test.partial-write",
            tone: "info",
            summary: "Already persisted before the injected interruption",
            payload: {},
            turnId,
            createdAt,
          },
          createdAt,
        })
        .pipe(Effect.orDie, Effect.asVoid);
      yield* run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("thread"),
          threadId,
          projectId,
          title: "Synthetic",
          modelSelection,
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      yield* run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("start"),
          threadId,
          message: {
            messageId: MessageId.make("user"),
            role: "user",
            text: "Reply with the synthetic marker",
            attachments: [],
          },
          modelSelection,
          interactionMode: "default",
          runtimeMode: "full-access",
          createdAt,
        }),
      );
      yield* run(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("starting"),
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      // A second independent subscriber mirrors CheckpointReactor. Receipt proves
      // the final event reached ProviderService's broadcast before we drain.
      const provider = yield* run(Effect.service(ProviderService));
      yield* run(
        Stream.runForEach(provider.streamEvents, (event) =>
          event.type === "turn.completed"
            ? Deferred.succeed(completedSeen, undefined)
            : Effect.void,
        ).pipe(Effect.forkIn(scope, { startImmediately: true })),
      );
      const base = {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId,
        createdAt,
        providerRefs: { providerThreadId: "01a14851-7e1f-79b3-a90c-0f8fc4c85f8f" },
      };
      const events: ProviderRuntimeEvent[] = [
        {
          ...base,
          type: "session.state.changed",
          eventId: EventId.make("ready"),
          payload: { state: "ready" },
        },
        { ...base, type: "turn.started", eventId: EventId.make("started"), turnId, payload: {} },
        {
          ...base,
          type: "item.completed",
          eventId: EventId.make("477ac994-92dc-4cab-a0bc-92de33151da1"),
          turnId,
          itemId: RuntimeItemId.make("msg_0b3caa4350007c58016ad3068ec508819492af92aaa1f3c46c"),
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            detail: "ELORA_REMOTE_OK",
          },
        },
        {
          ...base,
          type: "turn.completed",
          eventId: EventId.make("completed"),
          turnId,
          payload: { state: "completed" },
        },
      ];
      for (const event of events) yield* Queue.offer(queue, event);
      yield* Deferred.await(completedSeen);
      // When gated, the entire broadcast happens before activation. No update
      // may be lost, and none may be projected before the gate opens.
      if (gated) {
        const beforeActivation = yield* run(query.getSnapshot());
        expect(beforeActivation.threads.find((t) => t.id === threadId)?.session?.status).toBe(
          "starting",
        );
        expect(linkedChecks).toBe(0);
      }
      yield* Deferred.succeed(activation, undefined);
      if (failure !== "none") {
        const workerFiber = yield* Deferred.await(interruptedWorker);
        if (failure === "shutdown") {
          yield* Scope.close(runtimeScope, Exit.void);
          yield* Deferred.await(processingStopped);
          expect(Exit.isFailure(yield* Fiber.await(workerFiber))).toBe(true);
          expect(linkedChecks).toBe(1);
          expect(logs.join("\n")).not.toContain("ingestion failed");
          expect(logs.join("\n")).not.toContain("failure reporting failed");
          yield* Queue.offer(queue, events[0]!);
          expect(linkedChecks).toBe(1);
          return;
        }
        expect(Exit.isFailure(yield* Fiber.await(workerFiber))).toBe(true);
      }
      yield* Deferred.await(allInputsObserved);
      yield* run(ingestion.drain);
      const result = yield* run(query.getSnapshot());
      const thread = result.threads.find((t) => t.id === threadId);
      expect(thread?.session?.status).toBe("ready");
      expect(thread?.session?.activeTurnId).toBeNull();
      expect(thread?.messages.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual([
        "ELORA_REMOTE_OK",
      ]);
      expect(linkedChecks).toBe(events.length);
      const errors = thread?.activities.filter(
        (activity) => activity.kind === "runtime.ingestion.error",
      );
      expect(errors).toHaveLength(failure === "none" ? 0 : 1);
      if (failure !== "none") {
        expect(logs.join("\n")).toContain("provider runtime ingestion failed to process event");
        expect(errors?.[0]?.payload).toEqual({
          source: "runtime",
          eventId: "ready",
          eventType: "session.state.changed",
          replayed: false,
        });
      }
      expect(
        thread?.activities.filter((activity) => activity.kind === "test.partial-write"),
      ).toHaveLength(failure === "partial-write" ? 1 : 0);
    }),
  ),
);
