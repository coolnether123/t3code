import {
  ApprovalRequestId,
  ThreadId,
  TurnId,
  type ProviderRespondToRequestInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "@effect/vitest";
import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeApprovalResponseDelivery } from "./approvalResponseDelivery.ts";

const answer = {
  threadId: ThreadId.make("synthetic-thread"),
  requestId: ApprovalRequestId.make("synthetic-request"),
  decision: "accept" as const,
  createdAt: "2026-10-13T05:00:00.000Z",
};
const staleError = new ProviderAdapterRequestError({
  provider: "codex",
  method: "item/requestApproval/decision",
  detail: "Unknown pending Codex approval request: synthetic-request",
});

describe("approval reply delivery", () => {
  for (const scenario of [
    "callback",
    "stale",
    "uncertain",
    "wrong-thread",
    "already-read-back",
    "send-uncertain",
    "readback-delayed",
    "readback-missing",
  ] as const) {
    it.effect(`retains and delivers the saved answer safely: ${scenario}`, () => {
      const messages: string[] = [];
      let savedText = "";
      const record = vi.fn(
        (
          _answer: ProviderRespondToRequestInput & { createdAt: string },
          _kind: string,
          _route: string,
        ) => Effect.void,
      );
      const sendMessage = vi.fn(
        (
          _answer: ProviderRespondToRequestInput & { createdAt: string },
          _id: string,
          text: string,
        ) => {
          savedText = text;
          if (scenario === "send-uncertain") return Effect.fail(staleError);
          if (scenario !== "readback-missing") messages.push(text);
          return Effect.void;
        },
      );
      const respondToRequest = vi.fn(() =>
        scenario === "callback" ? Effect.void : Effect.fail(staleError),
      );
      if (scenario === "uncertain")
        respondToRequest.mockImplementation(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "codex",
              method: "item/requestApproval/decision",
              detail: "Response timed out",
            }),
          ),
        );
      let reads = 0;
      const readThread = vi.fn(() => {
        reads++;
        return Effect.succeed({
          threadId: ThreadId.make(
            scenario === "wrong-thread" ? "other-thread" : "synthetic-thread",
          ),
          turns: [
            {
              id: TurnId.make("synthetic-turn"),
              items: (scenario === "readback-delayed" && reads < 3 ? [] : messages).map((text) => ({
                type: "userMessage",
                content: [{ type: "text", text }],
              })),
            },
          ],
        });
      });
      const providerLayer = Layer.mock(ProviderService)({ respondToRequest, readThread });
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at,sequence)
          VALUES ('synthetic-approval','synthetic-thread',NULL,'approval','approval.requested','Synthetic approval','{"requestId":"synthetic-request"}',${answer.createdAt},1)`;
        const provider = yield* ProviderService;
        const make = () =>
          makeApprovalResponseDelivery({
            provider,
            record,
            sendMessage,
            stale: () => scenario !== "uncertain",
          });
        const delivery = yield* make();
        if (scenario === "already-read-back") {
          messages.push(
            `Approval reply recovered by T3. Request ${answer.requestId}: approved. This is the saved reply to the original request, not permission to repeat completed work or perform unrelated actions.`,
          );
        }
        yield* delivery.respond(answer);
        const confirm = yield* delivery.confirmThread(answer.threadId).pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(confirm);
        yield* delivery.respond(answer);
        const restarted = yield* make();
        yield* restarted.respond(answer);
        yield* restarted.recover();
        const [row] = yield* sql<{
          decision: string;
          status: string;
          attempts: number;
        }>`SELECT decision,status,attempts FROM approval_response_deliveries`;
        expect(row?.decision).toBe("accept");
        expect(row?.attempts).toBe(1);
        expect(row?.status).toBe(
          ["uncertain", "wrong-thread", "send-uncertain", "readback-missing"].includes(scenario)
            ? "escalated"
            : "delivered",
        );
      }).pipe(
        Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, providerLayer)),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(respondToRequest).toHaveBeenCalledTimes(1);
            expect(sendMessage).toHaveBeenCalledTimes(
              ["stale", "send-uncertain", "readback-delayed", "readback-missing"].includes(scenario)
                ? 1
                : 0,
            );
            expect(
              record.mock.calls.filter(
                (args) => args[1] === "provider.approval.delivery.escalated",
              ),
            ).toHaveLength(
              ["uncertain", "wrong-thread", "send-uncertain", "readback-missing"].includes(scenario)
                ? 1
                : 0,
            );
            if (scenario === "readback-missing") expect(readThread).toHaveBeenCalledTimes(4);
            if (scenario === "stale") expect(savedText).toContain(answer.requestId);
          }),
        ),
      );
    });
  }
});
