import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerConfig from "../config.ts";
import { callOperator } from "./callOperator.ts";
import { withoutCallControl, type OperatorLink } from "./operatorProtocol.ts";
import * as Auxiliary from "../provider/AuxiliaryProviderSessions.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { notificationTurnItem } from "@t3tools/provider-core/server/notification";
import type { CallCommand } from "./commands.ts";

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const config = yield* ServerConfig.ServerConfig;
  const calls = callOperator(config.stateDir);
  const sessions = yield* Auxiliary.AuxiliaryProviderSessions;
  const crypto = yield* Crypto.Crypto;
  const recordMessage = Effect.fn("VoiceThreadService.recordMessage")(function* (input: {
    readonly commandId: string;
    readonly threadId: string;
    readonly messageId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly streaming: boolean;
  }) {
    const threadId = ThreadId.make(input.threadId);
    return yield* executor.withLock(
      threadId,
      Effect.gen(function* () {
        const { projection } = yield* projections.getThreadSnapshot(threadId);
        const occurredAt = yield* DateTime.now;
        const messageId = MessageId.make(input.messageId);
        const previous = projection.messages.find((message) => message.id === messageId);
        const id = TurnItemId.make(input.messageId);
        const item = projection.turnItems.find((item) => item.id === id);
        const message = {
          ...(input.messageId.startsWith("voice-update:")
            ? {
                notification: {
                  source: { kind: "system" as const },
                  outcome: "updated" as const,
                  summary: input.text,
                },
              }
            : {}),
          id: messageId,
          threadId,
          role: input.role,
          text: input.text,
          streaming: input.streaming,
          runId: null,
          nodeId: null,
          attachments: [],
          createdBy: input.role === "user" ? ("user" as const) : ("agent" as const),
          creationSource: "server" as const,
          createdAt: previous?.createdAt ?? occurredAt,
          updatedAt: occurredAt,
        };
        const base = {
          id,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal:
            item?.ordinal ?? Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1,
          status: input.streaming ? ("running" as const) : ("completed" as const),
          title: null,
          startedAt: message.createdAt,
          completedAt: input.streaming ? null : occurredAt,
          updatedAt: occurredAt,
        };
        return yield* sink.commitCommand({
          commandId: CommandId.make(input.commandId),
          threadId,
          commandType: "voice.message.record",
          acceptedAt: occurredAt,
          effects: [],
          events: [
            {
              id: EventId.make(`${input.commandId}:message`),
              threadId,
              occurredAt,
              type: "message.updated",
              payload: message,
            },
            {
              id: EventId.make(`${input.commandId}:item`),
              threadId,
              occurredAt,
              type: "turn-item.updated",
              payload:
                input.role === "user"
                  ? notificationTurnItem(
                      {
                        ...base,
                        type: "user_message",
                        messageId,
                        text: input.text,
                        attachments: [],
                        inputIntent: "turn_start",
                        createdBy: "user",
                        creationSource: "server",
                      },
                      message,
                      projection.subagents,
                    )
                  : {
                      ...base,
                      type: "assistant_message",
                      messageId,
                      text: input.text,
                      streaming: input.streaming,
                    },
            },
          ],
        });
      }),
    );
  });
  const dispatch = Effect.fn("VoiceThreadService.dispatch")(function* (command: CallCommand) {
    if (command.type === "thread.turn.start") {
      if (yield* Effect.promise(() => calls.read(command.threadId))) {
        const recorded = yield* recordMessage({
          commandId: `${command.commandId}:utterance`,
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          streaming: false,
        });
        yield* Effect.tryPromise(() =>
          calls.voice({
            threadId: command.threadId,
            messageId: command.message.messageId,
            text: command.message.text,
            selection: command.modelSelection,
          }),
        );
        return recorded;
      }
      return yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: command.commandId,
        threadId: command.threadId,
        messageId: command.message.messageId,
        text: command.message.text,
        attachments: [],
        modelSelection: command.modelSelection,
        createdBy: "user",
        creationSource: "server",
        ...(command.message.messageId.startsWith("voice-update:")
          ? {
              notification: {
                source: { kind: "system" as const },
                outcome: "updated" as const,
                summary: command.message.text,
              },
            }
          : {}),
        dispatchMode: { type: "queue_after_active" },
      });
    }
    if (command.type === "thread.turn.interrupt") {
      const voice = yield* Effect.promise(() => calls.voiceSession(command.threadId));
      if (voice !== undefined)
        return yield* sessions.interruptTurn({ threadId: ThreadId.make(voice) });
      const { projection } = yield* projections.getThreadSnapshot(command.threadId);
      const run = projection.runs.find((run) =>
        ["running", "waiting", "starting"].includes(run.status),
      );
      if (run === undefined) return;
      return yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: command.commandId,
        threadId: command.threadId,
        runId: run.id,
      });
    }
    return yield* executor.withLock(
      command.threadId,
      Effect.gen(function* () {
        const { projection } = yield* projections.getThreadSnapshot(command.threadId);
        const occurredAt = yield* DateTime.now;
        return yield* sink.commitCommand({
          commandId: command.commandId,
          threadId: command.threadId,
          commandType: command.type,
          acceptedAt: occurredAt,
          effects: [],
          events: [
            {
              id: EventId.make(command.activity.id),
              threadId: command.threadId,
              occurredAt,
              type: "turn-item.updated",
              payload: {
                type: "system_notice",
                id: TurnItemId.make(command.activity.id),
                threadId: command.threadId,
                runId: null,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1,
                status: "completed",
                title: command.activity.summary,
                message: command.activity.summary,
                startedAt: occurredAt,
                completedAt: occurredAt,
                updatedAt: occurredAt,
                activity: { kind: command.activity.kind, payload: command.activity.payload },
              },
            },
          ],
        });
      }),
    );
  });
  const context = Effect.fn("VoiceThreadService.context")(function* (threadId: string) {
    const { projection } = yield* projections.getThreadSnapshot(ThreadId.make(threadId));
    const project = yield* projects.getShell(projection.thread.projectId);
    if (Option.isNone(project))
      return yield* Effect.fail(new Error("Call project is unavailable."));
    return {
      cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
      runtimeMode: projection.thread.runtimeMode,
      interactionMode: projection.thread.interactionMode,
      conversation: projection.messages
        .slice(-30)
        .map((message) => `${message.role}: ${message.text}`)
        .join("\n"),
      running: projection.runs.some((run) =>
        ["running", "waiting", "starting"].includes(run.status),
      ),
    };
  });
  const recordVoiceEvent = (link: OperatorLink, event: ProviderRuntimeEvent, text: string) =>
    recordMessage({
      commandId: event.eventId,
      threadId: link.threadId,
      messageId: `voice-reply:${link.sessionId}:${event.turnId ?? "pending"}`,
      role: "assistant",
      text: withoutCallControl(text),
      streaming: event.type !== "turn.completed",
    });
  const recordOperatorEvent = Effect.fn("VoiceThreadService.recordOperatorEvent")(function* (
    link: OperatorLink,
    event: ProviderAdapter.ProviderAdapterV2Event,
  ) {
    const threadId = ThreadId.make(link.threadId);
    return yield* executor.withLock(
      threadId,
      Effect.gen(function* () {
        const id = EventId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
        const occurredAt = yield* DateTime.now;
        const base = { id, threadId, occurredAt };
        let domain: OrchestrationV2DomainEvent | undefined;
        switch (event.type) {
          case "provider_thread.updated":
            domain = {
              ...base,
              type: "provider-thread.updated",
              payload: { ...event.providerThread, appThreadId: threadId },
            };
            break;
          case "provider_turn.updated":
            domain = {
              ...base,
              type: "provider-turn.updated",
              payload: { ...event.providerTurn, runAttemptId: null },
            };
            break;
          case "node.updated":
            domain = {
              ...base,
              type: "node.updated",
              payload: { ...event.node, threadId, runId: null, countsForRun: false },
            };
            break;
          case "runtime_request.updated":
            domain = { ...base, type: "runtime-request.updated", payload: event.runtimeRequest };
            break;
          case "turn_item.updated": {
            if (
              event.turnItem.type === "assistant_message" ||
              event.turnItem.type === "user_message"
            )
              return;
            const { projection } = yield* projections.getThreadSnapshot(threadId);
            const previous = projection.turnItems.find((item) => item.id === event.turnItem.id);
            domain = {
              ...base,
              type: "turn-item.updated",
              payload: {
                ...event.turnItem,
                threadId,
                runId: null,
                ordinal:
                  previous?.ordinal ??
                  Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1,
              },
            };
            break;
          }
        }
        if (domain !== undefined) yield* sink.write({ events: [domain] });
      }),
    );
  });
  return {
    dispatch,
    context,
    recordVoiceEvent,
    recordOperatorEvent,
    snapshot: (threadId: string) => projections.getThreadSnapshot(ThreadId.make(threadId)),
  };
});

export class VoiceThreadService extends Context.Service<
  VoiceThreadService,
  Effect.Success<typeof make>
>()("t3/speech/VoiceThreadService") {}

export const layer = Layer.effect(VoiceThreadService, make);
