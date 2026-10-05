import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The native Codex session states exposed by the T3 Codex chats surface. */
export const CodexDesktopThreadStatus = Schema.Literals([
  "idle",
  "active",
  "needs_attention",
  "error",
  "unknown",
]);
export type CodexDesktopThreadStatus = typeof CodexDesktopThreadStatus.Type;

export const CodexDesktopThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  preview: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  status: CodexDesktopThreadStatus,
});
export type CodexDesktopThread = typeof CodexDesktopThread.Type;

export const CodexDesktopToolStatus = Schema.Literals(["running", "completed", "error"]);
export type CodexDesktopToolStatus = typeof CodexDesktopToolStatus.Type;

export const CodexDesktopToolActivity = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: CodexDesktopToolStatus,
  detail: Schema.NullOr(Schema.String),
});
export type CodexDesktopToolActivity = typeof CodexDesktopToolActivity.Type;

export const CodexDesktopMessageRole = Schema.Literals(["user", "assistant", "tool"]);
export type CodexDesktopMessageRole = typeof CodexDesktopMessageRole.Type;

export const CodexDesktopMessage = Schema.Struct({
  id: TrimmedNonEmptyString,
  role: CodexDesktopMessageRole,
  text: Schema.String,
  createdAt: Schema.NullOr(IsoDateTime),
  tool: Schema.NullOr(CodexDesktopToolActivity),
});
export type CodexDesktopMessage = typeof CodexDesktopMessage.Type;

export const CodexDesktopThreadListResponse = Schema.Struct({
  threads: Schema.Array(CodexDesktopThread),
  nextCursor: Schema.NullOr(Schema.String),
});
export type CodexDesktopThreadListResponse = typeof CodexDesktopThreadListResponse.Type;

export const CodexDesktopThreadHistoryResponse = Schema.Struct({
  thread: CodexDesktopThread,
  messages: Schema.Array(CodexDesktopMessage),
  nextCursor: Schema.NullOr(Schema.String),
});
export type CodexDesktopThreadHistoryResponse = typeof CodexDesktopThreadHistoryResponse.Type;

/** A Codex desktop automation run remains outside T3 until explicitly imported. */
export const CodexScheduledRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  preview: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
});
export type CodexScheduledRun = typeof CodexScheduledRun.Type;

export const CodexScheduledRoutine = Schema.Struct({
  name: TrimmedNonEmptyString,
  latestRun: CodexScheduledRun,
  runCount: NonNegativeInt,
});
export type CodexScheduledRoutine = typeof CodexScheduledRoutine.Type;

export const CodexScheduledRoutineListResponse = Schema.Struct({
  routines: Schema.Array(CodexScheduledRoutine),
  nextCursor: Schema.NullOr(Schema.String),
});
export type CodexScheduledRoutineListResponse = typeof CodexScheduledRoutineListResponse.Type;

export const CodexScheduledRunListResponse = Schema.Struct({
  runs: Schema.Array(CodexScheduledRun),
  nextCursor: Schema.NullOr(Schema.String),
});
export type CodexScheduledRunListResponse = typeof CodexScheduledRunListResponse.Type;

export const CodexDesktopSendMessageRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
});
export type CodexDesktopSendMessageRequest = typeof CodexDesktopSendMessageRequest.Type;

export const CodexDesktopSendStatus = Schema.Literals(["queued", "sent", "error", "unknown"]);
export type CodexDesktopSendStatus = typeof CodexDesktopSendStatus.Type;

export const CodexDesktopSendMessageResponse = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  status: CodexDesktopSendStatus,
  message: Schema.NullOr(CodexDesktopMessage),
  error: Schema.NullOr(Schema.String),
});
export type CodexDesktopSendMessageResponse = typeof CodexDesktopSendMessageResponse.Type;

export const CodexDesktopHostStatus = Schema.Literals(["ready", "starting", "unavailable"]);
export type CodexDesktopHostStatus = typeof CodexDesktopHostStatus.Type;

export const CodexDesktopStatusResponse = Schema.Struct({
  status: CodexDesktopHostStatus,
  hostId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type CodexDesktopStatusResponse = typeof CodexDesktopStatusResponse.Type;
