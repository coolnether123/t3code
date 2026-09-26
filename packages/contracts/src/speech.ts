import * as Schema from "effect/Schema";

/** Local speech transport only. Conversation commands use the existing thread API. */
export const SpeechRequest = Schema.Struct({
  action: Schema.Literals(["acquire", "renew", "release", "transcribe", "speak"]),
  sessionId: Schema.optional(Schema.String),
  audio: Schema.optional(Schema.String),
  sampleRate: Schema.optional(Schema.Number),
  text: Schema.optional(Schema.String),
});
export type SpeechRequest = typeof SpeechRequest.Type;

export const SpeechResponse = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  audio: Schema.optional(Schema.String),
  sampleRate: Schema.optional(Schema.Number),
});
export type SpeechResponse = typeof SpeechResponse.Type;
