import * as S from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const id = TrimmedNonEmptyString;
const count = NonNegativeInt;
const textOrNull = S.NullOr(S.String);
const optionalText = S.optionalKey(textOrNull);
const tokens = S.Struct({ in: count, out: count, cached: count, total: count });
const chat = S.Union([
  S.Struct({ host: S.Literal("t3"), environmentId: id, threadId: id }),
  S.Struct({ host: S.Literal("otis"), threadId: optionalText }),
]);
export const OtisNode = S.Struct({
  id,
  parent: S.NullOr(id),
  lane: id,
  kind: S.Literals(["lane", "run", "subagent"]),
  mode: S.NullOr(S.Literals(["task", "chat"])),
  origin: S.Literals(["jared", "agent", "host"]),
  order: S.NullOr(count),
  title: TrimmedNonEmptyString.check(S.isMaxLength(120)),
  provider: id,
  model: id,
  modelEvidence: S.NullOr(S.Literals(["requested", "observed"])),
  effort: textOrNull,
  state: S.Literals(["queued", "starting", "running", "idle", "done", "failed", "stopped"]),
  stateReason: textOrNull,
  stateBy: textOrNull,
  observedAt: IsoDateTime,
  lastKnown: S.Boolean,
  waiting: count,
  tokens: S.NullOr(tokens),
  tokensReason: S.NullOr(S.Literals(["still-running", "provider-does-not-report"])),
  costUsd: S.NullOr(S.Finite),
  costSource: S.Literals(["provider", "priced", "unpriced", "api-equivalent-t3"]),
  sub: S.Struct({
    nodes: count,
    running: count,
    waiting: count,
    failedUnseen: count,
    failed: S.optionalKey(count),
    done: S.optionalKey(count),
    queued: S.optionalKey(count),
    tokens: count,
  }),
  budget: S.NullOr(
    S.Struct({ tokens: count, used: count, state: S.Literals(["ok", "near", "held"]) }),
  ),
  chat: S.NullOr(chat),
  can: S.Array(S.Literals(["message", "stop", "model", "resume", "child"])),
  startedAt: IsoDateTime,
  endedAt: textOrNull,
  lastActivityAt: optionalText,
  taskId: optionalText,
  seenAt: textOrNull,
  settled: S.Boolean,
  rev: count,
  tailSeq: count,
  spawnedByGeneration: S.optionalKey(S.NullOr(count)),
}).check(
  S.makeFilter(
    (node) =>
      (node.kind === "lane") === (node.parent === null) &&
      (node.kind === "run") === (node.mode !== null) &&
      (node.tokens !== null || node.tokensReason !== null) &&
      ((node.state !== "failed" && node.state !== "stopped") ||
        Boolean(node.stateReason?.trim())) &&
      (node.state !== "stopped" || Boolean(node.stateBy?.trim())),
  ),
);
export type OtisNode = typeof OtisNode.Type;

export const OtisTreeBatch = S.Struct({
  seq: count,
  nodes: S.Array(OtisNode),
  reset: S.optionalKey(S.Boolean),
});
export type OtisTreeBatch = typeof OtisTreeBatch.Type;
const historyPage = S.Struct({ nodes: S.Array(OtisNode), next: textOrNull });
export const OtisTreeRead = S.Union([
  S.Struct({ featuredWorkers: S.Literal(true) }),
  S.Struct({
    parent: id,
    settled: S.Literal(true),
    before: S.optionalKey(id),
    limit: S.optionalKey(PositiveInt),
  }),
  S.Struct({ nodeId: id }),
  S.Struct({ after: S.optionalKey(count) }),
]);
export const OtisTreeReadResult = S.Union([OtisTreeBatch, historyPage]);
export type OtisTreeRead = typeof OtisTreeRead.Type;
export type OtisTreeReadResult = typeof OtisTreeReadResult.Type;
const load = S.Struct({
  host: id,
  at: IsoDateTime,
  memPct: S.NullOr(S.Finite),
  cpuPct: S.NullOr(S.Finite),
  running: count,
  queued: count,
  room: S.optionalKey(S.NullOr(count)),
  roomReason: optionalText,
});
export const OtisTreeLine = S.Union([OtisTreeBatch, S.Struct({ load })]);
export const OtisWaiting = S.Struct({
  lanes: S.Array(
    S.Struct({
      laneId: id,
      title: id,
      requests: S.Array(
        S.Struct({
          requestId: id,
          nodeId: optionalText,
          laneId: id,
          kind: id,
          title: id,
          body: optionalText,
          yes: optionalText,
          no: optionalText,
          choices: S.optionalKey(S.NullOr(S.Array(S.String))),
          state: id,
          answer: optionalText,
          answeredVia: optionalText,
          expiresAt: optionalText,
        }),
      ),
      approvals: S.Array(
        S.Struct({
          approvalId: id,
          nodeId: optionalText,
          kind: id,
          title: optionalText,
          hash: optionalText,
        }),
      ),
    }),
  ),
});
export const OtisFleetEvent = S.Union([
  S.Struct({ type: S.Literal("unavailable") }),
  S.Struct({
    type: S.Literal("snapshot"),
    ...OtisTreeBatch.fields,
    waiting: S.NullOr(OtisWaiting),
    load: S.NullOr(load),
  }),
  S.Struct({ type: S.Literal("delta"), ...OtisTreeBatch.fields }),
  S.Struct({ type: S.Literal("waiting"), waiting: S.NullOr(OtisWaiting) }),
  S.Struct({ type: S.Literal("load"), load }),
]);
export type OtisFleetEvent = typeof OtisFleetEvent.Type;

const requestId = id;
const nodeId = id;
export const OtisAction = S.Union([
  S.Struct({
    type: S.Literal("parent.bind"),
    requestId,
    threadId: id,
    title: id.check(S.isMaxLength(120)),
  }),
  S.Struct({
    type: S.Literal("child.start"),
    requestId,
    parent: id,
    brief: id,
    provider: id,
    model: id,
    effort: textOrNull,
    mode: S.Literals(["chat", "task"]),
    home: S.Literals(["t3", "otis"]),
  }),
  S.Struct({ type: S.Literal("stop"), requestId, nodeId, subtree: S.Boolean }),
  S.Struct({ type: S.Literal("message"), requestId, nodeId, text: id }),
  S.Struct({ type: S.Literal("model.set"), requestId, nodeId, model: id, effort: textOrNull }),
  S.Struct({ type: S.Literal("budget.set"), requestId, nodeId, tokens: S.NullOr(count) }),
  S.Struct({ type: S.Literal("budget.set"), requestId, laneId: id, tokens: S.NullOr(count) }),
  S.Struct({ type: S.Literals(["resume", "seen", "retry"]), requestId, nodeId }),
]);
export type OtisAction = typeof OtisAction.Type;
export const OtisTailInput = S.Struct({
  nodeId,
  before: S.optionalKey(count),
  after: S.optionalKey(count),
  limit: S.optionalKey(PositiveInt),
});
export type OtisTailInput = typeof OtisTailInput.Type;
export const OtisTailPage = S.Struct({
  nodeId,
  items: S.Array(
    S.Struct({
      seq: count,
      at: IsoDateTime,
      role: S.Literals(["user", "assistant", "tool", "system"]),
      from: S.NullOr(S.Literals(["jared", "parent", "self"])),
      text: S.String,
      cut: S.Boolean,
      tool: S.NullOr(S.Struct({ name: id, status: id })),
    }),
  ),
  prev: S.NullOr(count),
  next: S.NullOr(count),
  end: S.Boolean,
});
export type OtisTailPage = typeof OtisTailPage.Type;
export const OtisActionResult = S.Union([
  OtisNode,
  S.Array(OtisNode),
  S.Array(id),
  S.Struct({ accepted: S.Boolean }),
]);
export type OtisActionResult = typeof OtisActionResult.Type;
export class OtisRpcError extends S.TaggedError<OtisRpcError>()("OtisRpcError", {
  reason: S.Literals(["unconfigured", "unavailable", "refused", "invalid-response"]),
  status: S.optionalKey(S.Int),
}) {
  override get message() {
    return this.status
      ? `Otis refused the request (HTTP ${this.status}).`
      : `Otis: ${this.reason}.`;
  }
}
const usageDay = S.String.check(S.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export const OtisLaneUsageInput = S.Struct({ since: usageDay, until: usageDay });
export type OtisLaneUsageInput = typeof OtisLaneUsageInput.Type;
export const OtisLaneUsage = S.Struct({
  ...OtisLaneUsageInput.fields,
  rows: S.Array(
    S.Struct({
      period: usageDay,
      lane: id,
      provider: id,
      usage: S.Struct({ costUsd: S.NullOr(S.Finite), complete: S.Boolean, records: count }),
    }),
  ),
});
export type OtisLaneUsage = typeof OtisLaneUsage.Type;

export const otisRpcs = [
  Rpc.make("otis.usage", {
    payload: OtisLaneUsageInput,
    success: OtisLaneUsage,
    error: S.Union([OtisRpcError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("otis.subscribe", {
    payload: { read: S.optionalKey(OtisTreeRead) },
    success: S.Union([
      OtisFleetEvent,
      S.Struct({ type: S.Literal("read"), result: OtisTreeReadResult }),
    ]),
    error: S.Union([OtisRpcError, EnvironmentAuthorizationError]),
    stream: true,
  }),
  Rpc.make("otis.act", { payload: OtisAction, success: OtisActionResult, error: OtisRpcError }),
  Rpc.make("otis.nodeTail", { payload: OtisTailInput, success: OtisTailPage, error: OtisRpcError }),
] as const;
