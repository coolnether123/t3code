// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type { OrchestrationThread, StoppedChatContinuationGuard } from "@t3tools/contracts";

export const authorityHash = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

export const isAutomaticApproval = (text: string): boolean =>
  text.includes("(via JEV)") || text.includes("Yes, save it. You asked for this at ");

export const isRequestedSaveReply = (text: string): boolean =>
  /^Yes, save it\. You asked for this at \d{1,2}:\d{2} [AP]M (?:CST|CDT)\.$/.test(text.trim());

export function stoppedChatContext(thread: OrchestrationThread) {
  const humans = thread.messages.filter(
    (message) =>
      message.role === "user" &&
      !isAutomaticApproval(message.text) &&
      !/^\s*(?:<|# AGENTS\.md|Otis applying )/i.test(message.text) &&
      !message.id.startsWith("automation:"),
  );
  const latestHuman = humans.at(-1);
  const assistant = thread.messages.findLast(
    (message) => message.role === "assistant" && message.turnId === thread.latestTurn?.turnId,
  );
  if (!latestHuman || !assistant || assistant.streaming || !assistant.text.trim()) return null;
  if (thread.messages.indexOf(latestHuman) > thread.messages.indexOf(assistant)) return null;
  if (
    thread.messages
      .slice(thread.messages.indexOf(assistant) + 1)
      .some((message) => message.role === "user")
  )
    return null;
  const automated = thread.messages
    .slice(thread.messages.indexOf(latestHuman) + 1)
    .filter((message) => message.role === "user" && isAutomaticApproval(message.text));
  const progress = thread.activities.some(
    (activity) =>
      activity.turnId === thread.latestTurn?.turnId &&
      activity.kind === "tool.completed" &&
      typeof activity.payload === "object" &&
      activity.payload !== null &&
      !(activity.payload as Record<string, unknown>).error &&
      (activity.payload as Record<string, unknown>).status === "completed",
  );
  return {
    humans: humans.map((message) => ({
      id: message.id,
      text: message.text,
      at: message.createdAt,
    })),
    question: assistant.text,
    count:
      automated.length +
      thread.activities.filter(
        (activity) =>
          activity.kind === "hook.feedback" &&
          activity.createdAt >= latestHuman.createdAt &&
          isAutomaticApproval(JSON.stringify(activity.payload)),
      ).length,
    nativeHookOwnsTurn: thread.activities.some(
      (activity) =>
        activity.kind === "hook.feedback" &&
        activity.turnId === thread.latestTurn?.turnId &&
        isAutomaticApproval(JSON.stringify(activity.payload)),
    ),
    progress,
    guard: {
      expectedTurnId: thread.latestTurn!.turnId,
      humanRevision: authorityHash(
        JSON.stringify(
          humans.map((message) => [message.id, message.text, message.createdAt, message.updatedAt]),
        ),
      ),
      assistantMessageId: assistant.id,
      pendingAskHash: authorityHash(assistant.text),
    } satisfies StoppedChatContinuationGuard,
  };
}

/** Called inside the serialized decider, immediately before creating message events. */
export function stoppedChatGuardFailure(
  thread: OrchestrationThread,
  guard: StoppedChatContinuationGuard,
): string | null {
  if (
    thread.archivedAt ||
    thread.deletedAt ||
    thread.snoozedUntil ||
    thread.settledOverride === "settled"
  )
    return "thread is held";
  if (
    thread.session?.status !== "ready" ||
    thread.session.activeTurnId !== null ||
    thread.latestTurn?.state !== "completed"
  )
    return "turn is not stopped";
  const current = stoppedChatContext(thread);
  if (
    !current ||
    current.guard.expectedTurnId !== guard.expectedTurnId ||
    current.guard.humanRevision !== guard.humanRevision ||
    current.guard.assistantMessageId !== guard.assistantMessageId ||
    current.guard.pendingAskHash !== guard.pendingAskHash
  )
    return "stopped ask or human revision changed";
  if (current.nativeHookOwnsTurn) return "native hook already continued this turn";
  if (current.count >= 2) return "continuation cap reached";
  if (current.count > 0 && !current.progress) return "no tool progress since continuation";
  return null;
}
