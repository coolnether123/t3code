import * as Schema from "effect/Schema";
import { ModelSelection } from "./orchestration.ts";

/** Local speech transport only. Conversation commands use the existing thread API. */
export const SpeechTransportRequest = Schema.Struct({
  action: Schema.Literals(["acquire", "renew", "release", "transcribe", "speak"]),
  sessionId: Schema.optional(Schema.String),
  audio: Schema.optional(Schema.String),
  sampleRate: Schema.optional(Schema.Number),
  text: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});
export type SpeechTransportRequest = typeof SpeechTransportRequest.Type;

const CallId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,100}$/));
export const CallPolicy = Schema.Literals(["confirm-actions", "confirm-all", "off"]);
export type CallPolicy = typeof CallPolicy.Type;
export const CallOptions = Schema.Struct({
  threadId: Schema.String,
  modelSelection: ModelSelection,
  policy: CallPolicy,
});
export type CallOptions = typeof CallOptions.Type;
export const CallRequest = Schema.Struct({
  action: Schema.Literals([
    "call.open",
    "call.prepare",
    "call.renew",
    "call.upload",
    "call.transcribe",
    "call.deliver",
    "call.status",
    "call.watch",
    "call.speak",
    "call.played",
    "call.interrupt",
    "call.confirm",
    "call.close",
  ]),
  callId: CallId,
  options: Schema.optional(CallOptions),
  utteranceId: Schema.optional(CallId),
  audio: Schema.optional(Schema.String),
  sampleRate: Schema.optional(Schema.Number),
  startedAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  speechId: Schema.optional(CallId),
  confirmationId: Schema.optional(CallId),
  decision: Schema.optional(Schema.Literals(["yes", "no"])),
  version: Schema.optional(Schema.String),
});
export type CallRequest = typeof CallRequest.Type;
export const SpeechRequest = Schema.Union([SpeechTransportRequest, CallRequest]);
export type SpeechRequest = typeof SpeechRequest.Type;

export const CallConfirmation = Schema.Struct({
  id: CallId,
  tool: Schema.String,
  summary: Schema.String,
  level: Schema.Literals(["read-back", "explicit-yes"]),
});
export type CallConfirmation = typeof CallConfirmation.Type;
export const CallUtterance = Schema.Struct({
  id: CallId,
  sha256: Schema.String,
  bytes: Schema.Number,
  sampleRate: Schema.Number,
  startedAt: Schema.String,
  endedAt: Schema.String,
  savedAt: Schema.String,
  text: Schema.optional(Schema.String),
  transcribedAt: Schema.optional(Schema.String),
  deliveredAt: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String),
  confirmationId: Schema.optional(Schema.String),
});
export type CallUtterance = typeof CallUtterance.Type;
export const CallStatus = Schema.Struct({
  callId: CallId,
  threadId: Schema.String,
  version: Schema.String,
  ready: Schema.Boolean,
  closed: Schema.Boolean,
  modelSelection: ModelSelection,
  policy: CallPolicy,
  steps: Schema.Array(Schema.String),
  utterances: Schema.Array(CallUtterance),
  pending: Schema.Array(CallConfirmation),
  played: Schema.Array(Schema.String),
});
export type CallStatus = typeof CallStatus.Type;

export const SpeechResponse = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  audio: Schema.optional(Schema.String),
  sampleRate: Schema.optional(Schema.Number),
  tenants: Schema.optional(Schema.Array(Schema.String)),
  call: Schema.optional(CallStatus),
  utterance: Schema.optional(CallUtterance),
});
export type SpeechResponse = typeof SpeechResponse.Type;
