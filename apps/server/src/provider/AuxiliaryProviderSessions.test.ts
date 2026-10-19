import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  NodeId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Auxiliary from "./AuxiliaryProviderSessions.ts";

it.effect("retries a rejected auxiliary send while still rejecting a second active turn", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
    const now = yield* DateTime.now;
    const instanceId = ProviderInstanceId.make("synthetic");
    const driver = ProviderDriverKind.make("codex");
    const threadId = ThreadId.make("t3-call-operator-synthetic");
    const providerThread = {
      id: ProviderThreadId.make("synthetic-provider-thread"),
      driver,
      providerInstanceId: instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle" as const,
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    let attempts = 0;
    const manager = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      close: () => Effect.void,
      open: (input) =>
        Effect.succeed({
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: "synthetic",
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: () => Effect.succeed(providerThread),
          resumeThread: () => Effect.succeed(providerThread),
          startTurn: () =>
            Effect.suspend(() => {
              attempts++;
              if (attempts === 1)
                return Effect.fail(
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver,
                    detail: "Synthetic rejection",
                  }),
                );
              return Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make("accepted-turn"),
                  providerThreadId: providerThread.id,
                  nodeId: NodeId.make("synthetic-node"),
                  runAttemptId: null,
                  nativeTurnRef: null,
                  ordinal: attempts,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              }).pipe(Effect.asVoid);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        }),
    });
    const registry = Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      get: () =>
        Effect.succeed(
          ProviderAdapter.ProviderAdapterV2.of({
            instanceId,
            driver,
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
            openSession: () => Effect.die("manager owns opening"),
          }),
        ),
    });
    yield* Effect.gen(function* () {
      const sessions = yield* Auxiliary.AuxiliaryProviderSessions;
      const modelSelection = { instanceId, model: "synthetic" };
      yield* sessions.startSession(threadId, {
        threadId,
        modelSelection,
        runtimeMode: "approval-required",
      });
      const send = () => sessions.sendTurn({ threadId, modelSelection, input: "Hello" });
      expect((yield* Effect.exit(send()))._tag).toBe("Failure");
      expect((yield* sessions.listSessions())[0]?.status).toBe("ready");
      expect((yield* send()).turnId).toBe("accepted-turn");
      expect((yield* Effect.exit(send()))._tag).toBe("Failure");
      expect(attempts).toBe(2);
    }).pipe(
      Effect.provide(
        Auxiliary.layer.pipe(
          Layer.provide(Layer.merge(manager, registry)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  }),
);
