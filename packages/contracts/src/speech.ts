import * as Schema from "effect/Schema";
import { ModelSelection } from "./orchestration.ts";

// Router startup allows 600 seconds. Leave time to return the granted lease.
export const CALL_PREPARE_TIMEOUT_MS = 660_000;

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
export const CallOptions = Schema.Struct({
  threadId: Schema.String,
  modelSelection: ModelSelection,
});
export type CallOptions = typeof CallOptions.Type;
export const CallRequest = Schema.Struct({
  streamAudio: Schema.optional(Schema.Boolean),
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
    "call.close",
  ]),
  callId: CallId,
  options: Schema.optional(CallOptions),
  modelSelection: Schema.optional(ModelSelection),
  utteranceId: Schema.optional(CallId),
  audio: Schema.optional(Schema.String),
  sampleRate: Schema.optional(Schema.Number),
  startedAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  speechId: Schema.optional(CallId),
  version: Schema.optional(Schema.String),
});
export type CallRequest = typeof CallRequest.Type;
export const ValidCallRequest = CallRequest.check(
  Schema.makeFilter((input) => {
    switch (input.action) {
      case "call.open":
        return !!input.options || "Call options are required.";
      case "call.upload":
        return (
          (!!input.utteranceId &&
            !!input.audio &&
            !!input.sampleRate &&
            !!input.startedAt &&
            !!input.endedAt) ||
          "Upload requires PCM and recording metadata."
        );
      case "call.transcribe":
      case "call.deliver":
      case "call.interrupt":
        return !!input.utteranceId || "An utterance or operation ID is required.";
      case "call.speak":
        return (!!input.speechId && !!input.text?.trim()) || "Speech requires an ID and text.";
      case "call.played":
        return !!input.speechId || "A speech ID is required.";
      default:
        return true;
    }
  }),
);
export const SpeechRequest = Schema.Union([SpeechTransportRequest, ValidCallRequest]);
export type SpeechRequest = typeof SpeechRequest.Type;

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
  modelSelection: Schema.optional(ModelSelection),
});
export type CallUtterance = typeof CallUtterance.Type;
export const CallStatus = Schema.Struct({
  callId: CallId,
  threadId: Schema.String,
  version: Schema.String,
  ready: Schema.Boolean,
  closed: Schema.Boolean,
  modelSelection: ModelSelection,
  steps: Schema.Array(Schema.String),
  utterances: Schema.Array(CallUtterance),
  played: Schema.Array(Schema.String),
});
export type CallStatus = typeof CallStatus.Type;

export const SpeechResponse = Schema.Struct({
  complete: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.String),
  played: Schema.optional(Schema.Boolean),
  sessionId: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  audio: Schema.optional(Schema.String),
  sampleRate: Schema.optional(Schema.Number),
  tenants: Schema.optional(Schema.Array(Schema.String)),
  call: Schema.optional(CallStatus),
  utterance: Schema.optional(CallUtterance),
});
export type SpeechResponse = typeof SpeechResponse.Type;
