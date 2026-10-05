import type { ThreadId, TurnId } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import { sessionUpdateIsReplay } from "./AcpRuntimeModel.ts";

const Counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Currency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/));
const Amount = Schema.Number.check(Schema.isFinite());
const tokenFields = [
  "inputTokens",
  "outputTokens",
  "cachedReadTokens",
  "cachedWriteTokens",
  "thoughtTokens",
  "totalTokens",
] as const;

export const AcpTokenCounters = Schema.Struct({
  inputTokens: Schema.NullOr(Counter),
  outputTokens: Schema.NullOr(Counter),
  cachedReadTokens: Schema.NullOr(Counter),
  cachedWriteTokens: Schema.NullOr(Counter),
  thoughtTokens: Schema.NullOr(Counter),
  totalTokens: Schema.NullOr(Counter),
});
const InvalidField = Schema.Literals([...tokenFields, "usage", "used", "size", "cost"]);
const PromptObservation = Schema.Struct({
  source: Schema.Literal("prompt-response"),
  tokenBasis: Schema.Literals(["request", "ambiguous", "unavailable"]),
  reportedTokens: AcpTokenCounters,
  requestTokens: AcpTokenCounters,
  scopeConflict: Schema.Boolean,
  invalidFields: Schema.Array(InvalidField).check(Schema.isMaxLength(10)),
});
const SessionObservation = Schema.Struct({
  source: Schema.Literal("usage-update"),
  tokenBasis: Schema.Literal("session"),
  contextUsedTokens: Schema.NullOr(Counter),
  contextSizeTokens: Schema.NullOr(Counter),
  sessionCost: Schema.NullOr(Schema.Struct({ amount: Amount, currency: Currency })),
  invalidFields: Schema.Array(InvalidField).check(Schema.isMaxLength(10)),
});
const identityFields = {
  version: Schema.Literal(1),
  provider: Schema.Literals(["cursor", "grok"]),
  nativeSessionId: Identifier,
};

/** Metadata retained in the existing native log, not normalized turn accounting. */
export const AcpUsageMetadata = Schema.Union([
  Schema.Struct({
    ...identityFields,
    ...PromptObservation.fields,
    turnId: Identifier,
    requestId: Identifier,
    outcome: Schema.Literals(["succeeded", "cancelled", "failed", "interrupted"]),
    receiptConflict: Schema.Boolean,
    previousReportedTokens: Schema.NullOr(AcpTokenCounters),
    acknowledgementMismatch: Schema.Boolean,
  }),
  Schema.Struct({
    ...identityFields,
    ...SessionObservation.fields,
    turnId: Schema.Null,
    requestId: Schema.Null,
  }),
]);
export type AcpUsageMetadata = typeof AcpUsageMetadata.Type;

const decodeCounter = Schema.decodeUnknownExit(Counter);
const decodeCost = Schema.decodeUnknownExit(Schema.Struct({ amount: Amount, currency: Currency }));
const validIdentifier = Schema.is(Identifier);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const unreadableField = Symbol("unreadable ACP field");
const emptyTokens = (): typeof AcpTokenCounters.Type => ({
  inputTokens: null,
  outputTokens: null,
  cachedReadTokens: null,
  cachedWriteTokens: null,
  thoughtTokens: null,
  totalTokens: null,
});

// Read only declared data properties. Never traverse _meta or invoke an accessor.
function ownField(value: unknown, key: string): unknown {
  if (!Predicate.isObject(value)) return undefined;
  try {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property === undefined
      ? undefined
      : "value" in property
        ? property.value
        : unreadableField;
  } catch {
    return unreadableField;
  }
}

function readCounter(
  value: unknown,
  field: typeof InvalidField.Type,
  invalidFields: Array<typeof InvalidField.Type>,
): number | null {
  if (value === undefined || value === null) return null;
  const decoded = decodeCounter(value);
  if (Exit.isSuccess(decoded)) return decoded.value;
  invalidFields.push(field);
  return null;
}

/** Request basis requires an independently established per-request provider contract. */
export function readAcpPromptUsage(
  response: unknown,
  basis: "request" | "ambiguous" = "ambiguous",
): typeof PromptObservation.Type {
  const usage = ownField(response, "usage");
  const invalidFields: Array<typeof InvalidField.Type> = [];
  const reportedTokens = { ...emptyTokens() };
  if (usage !== undefined && usage !== null) {
    if (!Predicate.isObject(usage)) {
      invalidFields.push("usage");
    } else {
      for (const field of tokenFields) {
        reportedTokens[field] = readCounter(ownField(usage, field), field, invalidFields);
      }
    }
  }
  const available = tokenFields.some((field) => reportedTokens[field] !== null);
  return {
    source: "prompt-response",
    tokenBasis: available ? basis : "unavailable",
    reportedTokens,
    requestTokens: available && basis === "request" ? { ...reportedTokens } : emptyTokens(),
    scopeConflict: available && basis === "ambiguous",
    invalidFields,
  };
}

export function readAcpSessionUsage(update: unknown): typeof SessionObservation.Type {
  const invalidFields: Array<typeof InvalidField.Type> = [];
  const cost = ownField(update, "cost");
  const decodedCost = decodeCost({
    amount: ownField(cost, "amount"),
    currency: ownField(cost, "currency"),
  });
  if (cost !== undefined && cost !== null && Exit.isFailure(decodedCost)) {
    invalidFields.push("cost");
  }
  return {
    source: "usage-update",
    tokenBasis: "session",
    contextUsedTokens: readCounter(ownField(update, "used"), "used", invalidFields),
    contextSizeTokens: readCounter(ownField(update, "size"), "size", invalidFields),
    sessionCost:
      cost !== undefined && cost !== null && Exit.isSuccess(decodedCost) ? decodedCost.value : null,
    invalidFields,
  };
}

/** One capture per native session. Retention and buffering belong to EventNdjsonLogger. */
export const makeAcpUsageCapture = Effect.fn("makeAcpUsageCapture")(function* (input: {
  readonly provider: "cursor" | "grok";
  readonly threadId: ThreadId;
  readonly nativeSessionId: string;
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
}) {
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const recentRequests = new Map<
    string,
    { fingerprint: string; tokens: typeof AcpTokenCounters.Type }
  >();
  let lastSessionFingerprint: string | undefined;

  const write = Effect.fn("AcpUsage.write")(
    function* (id: string, payload: AcpUsageMetadata) {
      if (!input.nativeEventLogger || !validIdentifier(input.nativeSessionId)) return;
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      yield* input.nativeEventLogger.write(
        {
          observedAt,
          event: {
            id,
            kind: "usage",
            provider: input.provider,
            createdAt: observedAt,
            method: payload.source === "prompt-response" ? "session/prompt" : "session/update",
            threadId: input.threadId,
            payload,
          },
        },
        input.threadId,
      );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to retain ACP usage metadata.", {
        provider: input.provider,
        errorTag: causeErrorTag(cause),
      }),
    ),
  );

  const capturePrompt = Effect.fn("AcpUsage.capturePrompt")(
    function* (receipt: {
      readonly turnId: TurnId;
      readonly requestId: string;
      readonly response?: unknown;
      readonly outcome: "succeeded" | "cancelled" | "failed" | "interrupted";
    }) {
      if (
        !input.nativeEventLogger ||
        !validIdentifier(input.nativeSessionId) ||
        !validIdentifier(receipt.turnId) ||
        !validIdentifier(receipt.requestId)
      )
        return;
      const observation = readAcpPromptUsage(receipt.response);
      const acknowledged = ownField(receipt.response, "userMessageId");
      const acknowledgementMismatch =
        acknowledged !== undefined && acknowledged !== null && acknowledged !== receipt.requestId;
      const id = encodeJson([
        input.provider,
        input.nativeSessionId,
        receipt.turnId,
        receipt.requestId,
      ]);
      const fingerprint = encodeJson([observation, receipt.outcome, acknowledgementMismatch]);
      const previous = recentRequests.get(id);
      if (previous?.fingerprint === fingerprint) return;
      yield* write(id, {
        version: 1,
        provider: input.provider,
        nativeSessionId: input.nativeSessionId,
        turnId: receipt.turnId,
        requestId: receipt.requestId,
        ...observation,
        outcome: receipt.outcome,
        receiptConflict: previous !== undefined,
        previousReportedTokens: previous?.tokens ?? null,
        acknowledgementMismatch,
      });
      recentRequests.set(id, { fingerprint, tokens: observation.reportedTokens });
      if (recentRequests.size > 256) recentRequests.delete(recentRequests.keys().next().value!);
    },
    (effect) => lock.withPermit(effect),
  );

  const capturePromptExit =
    (turnId: TurnId, requestId: string) =>
    (exit: Exit.Exit<AcpSchema.PromptResponse, AcpErrors.AcpError>) =>
      capturePrompt({
        turnId,
        requestId,
        ...(Exit.isSuccess(exit) ? { response: exit.value } : {}),
        outcome: Exit.isSuccess(exit)
          ? exit.value.stopReason === "cancelled"
            ? "cancelled"
            : "succeeded"
          : Cause.hasInterrupts(exit.cause)
            ? "interrupted"
            : "failed",
      });

  const captureSessionUpdate = Effect.fn("AcpUsage.captureSessionUpdate")(
    function* (notification: AcpSchema.SessionNotification) {
      if (
        !input.nativeEventLogger ||
        notification.sessionId !== input.nativeSessionId ||
        notification.update.sessionUpdate !== "usage_update" ||
        sessionUpdateIsReplay(notification)
      )
        return;
      const observation = readAcpSessionUsage(notification.update);
      const fingerprint = encodeJson(observation);
      if (fingerprint === lastSessionFingerprint) return;
      yield* write(yield* crypto.randomUUIDv4, {
        version: 1,
        provider: input.provider,
        nativeSessionId: input.nativeSessionId,
        turnId: null,
        requestId: null,
        ...observation,
      });
      lastSessionFingerprint = fingerprint;
    },
    (effect) => lock.withPermit(effect),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to retain ACP session usage metadata.", {
        provider: input.provider,
        errorTag: causeErrorTag(cause),
      }),
    ),
  );

  return { capturePrompt, capturePromptExit, captureSessionUpdate };
});
