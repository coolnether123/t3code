import * as Rpc from "effect/rpc/Rpc";
import * as S from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import * as Front from "./otisFront.ts";
import { OtisRpcError } from "./otisTree.ts";

const error = S.Union([OtisRpcError, EnvironmentAuthorizationError]);
export const OtisFrontSubscription = S.Struct({
  after: S.optionalKey(S.Int.check(S.isGreaterThanOrEqualTo(0))),
});
export const OtisFrontUpdate = S.Union([
  Front.FrontEvent,
  S.Struct({ type: S.Literal("connected"), taskDashboardUrl: S.optionalKey(S.String) }),
  S.Struct({ type: S.Literal("unavailable") }),
]);
export type OtisFrontUpdate = typeof OtisFrontUpdate.Type;
export const OtisFrontAction = S.Struct({ actionId: Front.Id, ...Front.ActionRequest.fields });
export const OtisFrontHistory = S.Struct({
  before: S.optionalKey(Front.Id),
  limit: S.optionalKey(S.Int.check(S.isGreaterThan(0))),
});

export const otisFrontRpcs = [
  Rpc.make("otis.front.subscribe", {
    payload: OtisFrontSubscription,
    success: OtisFrontUpdate,
    error,
    stream: true,
  }),
  Rpc.make("otis.front.turn", { payload: Front.TurnRequest, success: Front.TurnAccepted, error }),
  Rpc.make("otis.front.cancel", {
    payload: { turnId: Front.Id },
    success: Front.TurnCancelled,
    error,
  }),
  Rpc.make("otis.front.action", {
    payload: OtisFrontAction,
    success: Front.ActionResult,
    error,
  }),
  Rpc.make("otis.front.history", {
    payload: OtisFrontHistory,
    success: Front.ConversationPage,
    error,
  }),
  Rpc.make("otis.front.report", { success: Front.LatestMorningReport, error }),
  Rpc.make("otis.front.heard", {
    payload: { reportId: Front.Id },
    success: Front.ReportHeard,
    error,
  }),
] as const;
