import { ThreadId, ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
type DeliveryError =
  | Effect.Error<ReturnType<OrchestrationEngineService["Service"]["dispatch"]>>
  | import("../provider/Errors.ts").ProviderServiceError;

type Answer = {
  threadId: ThreadId;
  requestId: ApprovalRequestId;
  decision: ProviderApprovalDecision;
  createdAt: string;
};
type Delivery = {
  thread_id: string;
  request_id: string;
  decision: ProviderApprovalDecision;
  status: string;
  message_id: string;
  message_text: string;
  created_at: string;
  route: string | null;
  recorded: number;
};

/** Approval intent is durable independently of a provider's in-memory callback. */
export const makeApprovalResponseDelivery = Effect.fn("makeApprovalResponseDelivery")(
  function* (input: {
    provider: ProviderServiceShape;
    stale: (cause: Cause.Cause<import("../provider/Errors.ts").ProviderServiceError>) => boolean;
    record: (answer: Answer, kind: string, route: string) => Effect.Effect<unknown, DeliveryError>;
    sendMessage: (
      answer: Answer,
      messageId: string,
      text: string,
    ) => Effect.Effect<unknown, DeliveryError>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const setStatus = (answer: Answer, status: string) => sql`
    UPDATE approval_response_deliveries SET status=${status},updated_at=${answer.createdAt}
    WHERE thread_id=${answer.threadId} AND request_id=${answer.requestId}`;
    const messageText = (answer: Answer) =>
      `Approval reply recovered by T3. Request ${answer.requestId}: ${{ accept: "approved", acceptForSession: "approved for the original session", acceptAlways: "approved with the original request's saved scope", decline: "declined", cancel: "cancelled" }[answer.decision]}. This is the saved reply to the original request, not permission to repeat completed work or perform unrelated actions.`;
    const hasMessage = (turns: ReadonlyArray<{ items: ReadonlyArray<unknown> }>, text: string) =>
      turns.some((turn) =>
        turn.items.some((raw) => {
          if (!raw || typeof raw !== "object") return false;
          const item = raw as Record<string, unknown>;
          if (item.type !== "userMessage") return false;
          return (
            Array.isArray(item.content) &&
            item.content.some(
              (part) =>
                part &&
                typeof part === "object" &&
                (part as Record<string, unknown>).type === "text" &&
                (part as Record<string, unknown>).text === text,
            )
          );
        }),
      );
    const escalate = (answer: Answer, route: string) =>
      Effect.gen(function* () {
        yield* sql`UPDATE approval_response_deliveries SET status='escalated',route=${route},recorded=0 WHERE thread_id=${answer.threadId} AND request_id=${answer.requestId}`;
        yield* input.record(answer, "provider.approval.delivery.escalated", route);
        yield* sql`UPDATE approval_response_deliveries SET recorded=1 WHERE thread_id=${answer.threadId} AND request_id=${answer.requestId}`;
      });
    const confirmed = (answer: Answer, route: string) =>
      Effect.gen(function* () {
        yield* sql`UPDATE approval_response_deliveries SET status='delivered',route=${route},recorded=0 WHERE thread_id=${answer.threadId} AND request_id=${answer.requestId}`;
        yield* input.record(answer, "provider.approval.delivery.confirmed", route);
        yield* sql`UPDATE approval_response_deliveries SET recorded=1 WHERE thread_id=${answer.threadId} AND request_id=${answer.requestId}`;
      });
    const fallback = Effect.fn("fallbackApprovalDecision")(function* (
      answer: Answer,
      messageId: string,
      attempted: boolean,
      text: string,
      readbackFailureRoute = "readback-unavailable",
    ) {
      const original = yield* sql`SELECT activity_id FROM projection_thread_activities
      WHERE thread_id=${answer.threadId} AND kind='approval.requested'
      AND json_extract(payload_json,'$.requestId')=${answer.requestId} LIMIT 1`;
      if (!original.length) return yield* escalate(answer, "request-context-unavailable");
      if (!input.provider.readThread) return yield* escalate(answer, readbackFailureRoute);
      const before = yield* Effect.result(input.provider.readThread(answer.threadId));
      if (before._tag === "Failure") return yield* escalate(answer, readbackFailureRoute);
      if (before.success.threadId !== answer.threadId)
        return yield* escalate(answer, "conversation-mismatch");
      if (hasMessage(before.success.turns, text))
        return yield* confirmed(answer, "message-readback");
      // A crash or timeout after a send is not permission to repeat the decision.
      if (attempted) return yield* escalate(answer, "delivery-uncertain");
      yield* setStatus(answer, "fallback-attempting");
      const sent = yield* Effect.result(input.sendMessage(answer, messageId, text));
      if (sent._tag === "Failure") return yield* escalate(answer, "delivery-uncertain");
      // The ordinary thread queue owns sending. It confirms readback after that intent drains.
      yield* setStatus(answer, "fallback-queued");
    });
    const deliverClaimed = Effect.fn("deliverClaimedApproval")(function* (
      answer: Answer,
      messageId: string,
      text: string,
    ) {
      yield* input.record(answer, "provider.approval.delivery.pending", "callback");
      yield* setStatus(answer, "callback-attempting");
      yield* sql`UPDATE approval_response_deliveries SET attempts=attempts+1 WHERE thread_id=${answer.threadId} AND request_id=${answer.requestId}`;
      const replied = yield* Effect.exit(
        input.provider.respondToRequest({
          threadId: answer.threadId,
          requestId: answer.requestId,
          decision: answer.decision,
        }),
      );
      if (replied._tag === "Success") return yield* confirmed(answer, "callback");
      if (Cause.hasInterruptsOnly(replied.cause)) return yield* Effect.failCause(replied.cause);
      if (input.stale(replied.cause)) {
        yield* setStatus(answer, "fallback-pending");
        yield* input.record(answer, "provider.approval.respond.failed", "stale");
        return yield* fallback(answer, messageId, false, text);
      }
      // A response timeout may follow acceptance. Never resend an ambiguous answer.
      yield* input.record(answer, "provider.approval.respond.failed", "uncertain");
      return yield* escalate(answer, "callback-delivery-uncertain");
    });
    const respond = Effect.fn("deliverApprovalDecision")(function* (answer: Answer) {
      const acknowledged = yield* sql`SELECT activity_id FROM projection_thread_activities
      WHERE thread_id=${answer.threadId} AND kind IN ('approval.resolved','provider.approval.delivery.confirmed')
      AND json_extract(payload_json,'$.requestId')=${answer.requestId} LIMIT 1`;
      if (acknowledged.length) return;
      const messageId = `approval-recovery:${answer.threadId}:${answer.requestId}`;
      const text = messageText(answer);
      const claimed = yield* sql`INSERT INTO approval_response_deliveries
      (thread_id,request_id,decision,status,message_id,message_text,created_at,updated_at)
      VALUES (${answer.threadId},${answer.requestId},${answer.decision},'pending',${messageId},${text},${answer.createdAt},${answer.createdAt})
      ON CONFLICT (thread_id,request_id) DO NOTHING RETURNING request_id`;
      if (!claimed.length) return;
      return yield* deliverClaimed(answer, messageId, text);
    });
    const recover = Effect.fn("recoverApprovalDeliveries")(function* () {
      const rows =
        yield* sql<Delivery>`SELECT * FROM approval_response_deliveries WHERE status NOT IN ('delivered','escalated') OR recorded=0
        OR (status='escalated' AND route IN ('readback-unavailable','delivery-uncertain'))`;
      for (const row of rows) {
        const answer: Answer = {
          threadId: ThreadId.make(row.thread_id),
          requestId: ApprovalRequestId.make(row.request_id),
          decision: row.decision,
          createdAt: row.created_at,
        };
        if (row.status === "pending")
          yield* deliverClaimed(answer, row.message_id, row.message_text);
        else if (row.status === "delivered") yield* confirmed(answer, row.route ?? "callback");
        else if (row.status === "escalated" && row.route === "readback-unavailable") {
          // Only a pre-send readback failure can be recovered without ambiguity.
          // Persist the one recovery attempt before touching the provider.
          const sent = yield* sql`SELECT sequence FROM orchestration_events
            WHERE command_id=${`server:approval-message:${row.thread_id}:${row.request_id}`} LIMIT 1`;
          if (sent.length) continue;
          yield* sql`UPDATE approval_response_deliveries SET status='fallback-recovery-attempting',route='readback-recovery-attempted'
            WHERE thread_id=${row.thread_id} AND request_id=${row.request_id}`;
          yield* fallback(
            answer,
            row.message_id,
            false,
            row.message_text,
            "readback-recovery-unavailable",
          );
        } else if (row.status === "escalated" && row.route === "delivery-uncertain")
          yield* confirmThread(answer.threadId);
        else if (row.status === "escalated")
          yield* escalate(answer, row.route ?? "delivery-uncertain");
        else if (row.status.startsWith("fallback-"))
          yield* fallback(
            answer,
            row.message_id,
            row.status !== "fallback-pending",
            row.message_text,
          );
        else yield* escalate(answer, "callback-delivery-uncertain");
      }
    });
    const confirmThread = Effect.fn("confirmApprovalMessage")(function* (threadId: ThreadId) {
      const rows =
        yield* sql<Delivery>`SELECT * FROM approval_response_deliveries WHERE thread_id=${threadId}
        AND (status='fallback-queued' OR (status='escalated' AND route='delivery-uncertain'))`;
      for (const row of rows) {
        const answer: Answer = {
          threadId,
          requestId: ApprovalRequestId.make(row.request_id),
          decision: row.decision,
          createdAt: row.created_at,
        };
        if (!input.provider.readThread) {
          if (row.status === "escalated") continue;
          yield* escalate(answer, "readback-unavailable");
          continue;
        }
        let found = false;
        for (const delay of [0, 250, 1000]) {
          if (delay) yield* Effect.sleep(delay);
          const snapshot = yield* Effect.result(input.provider.readThread(threadId));
          if (
            snapshot._tag === "Success" &&
            snapshot.success.threadId === threadId &&
            hasMessage(snapshot.success.turns, row.message_text)
          ) {
            yield* confirmed(answer, "message-readback");
            found = true;
            break;
          }
        }
        if (!found && row.status !== "escalated") yield* escalate(answer, "delivery-uncertain");
      }
    });
    return { respond, recover, confirmThread };
  },
);
