import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  OrchestrationCommand,
  OrchestrationEvent,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import { shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";

const now = "2026-10-07T09:30:00.000Z";
const threadId = ThreadId.make("synthetic-recovery");
const command = {
  type: "thread.agent-final.attach" as const,
  commandId: CommandId.make("synthetic-attachment"),
  threadId,
  messageId: MessageId.make("operator-agent-final:synthetic-native:synthetic-turn"),
  text: "  The existing agent final.\n",
  nativeThreadId: "synthetic-native",
  nativeTurnId: "synthetic-turn",
  nativeMessageId: "synthetic-final",
  expectedLatestUserMessageAt: now,
  createdAt: now,
};
const model: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  updatedAt: now,
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("synthetic-project"),
      title: "Synthetic",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "synthetic" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      proposedPlans: [],
      checkpoints: [],
      messages: [
        {
          id: MessageId.make("human"),
          role: "user",
          text: "Existing request",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      activities: [
        {
          id: EventId.make("pending"),
          kind: "user-input.requested",
          tone: "approval",
          summary: "Existing question",
          turnId: null,
          createdAt: now,
          payload: { requestId: "untouched" },
        },
      ],
    },
  ],
};
it.layer(NodeServices.layer)("operator agent final display", (it) => {
  it.effect("shows the exact final with attribution, without user input or provider intent", () =>
    Effect.gen(function* () {
      const decodedCommand = yield* Schema.decodeUnknownEffect(OrchestrationCommand)(command);
      const planned = yield* decideOrchestrationCommand({
        command: decodedCommand,
        readModel: model,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual(["thread.message-sent"]);
      const event = yield* Schema.decodeUnknownEffect(OrchestrationEvent)({ ...events[0]!, sequence: 1 });
      expect(event.metadata).toMatchObject({
        operatorAttachment: true,
        historyImport: true,
        nativeTurnId: "synthetic-turn",
      });
      expect(shouldPublishAgentAwarenessEvent(event)).toBe(false);
      const projected = yield* projectEvent(model, event);
      const before = model.threads[0]!;
      const after = projected.threads[0]!;
      expect(after.messages.filter((message) => message.role === "user")).toEqual(before.messages);
      expect(after.messages.at(-1)).toMatchObject({
        role: "assistant",
        streaming: false,
        turnId: null,
        text: "Otis operator copy, not from Christine. Existing agent reply, copied without sending instructions.\n\n  The existing agent final.\n",
      });
      expect(after.session).toEqual(before.session);
      expect(after.latestTurn).toEqual(before.latestTurn);
      expect(after.activities).toEqual(before.activities);
      expect(yield* decideOrchestrationCommand({ command, readModel: projected })).toEqual([]);
    }),
  );
  it.effect("rejects a newer human request before attachment", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: { ...command, expectedLatestUserMessageAt: null },
        readModel: model,
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );
});
