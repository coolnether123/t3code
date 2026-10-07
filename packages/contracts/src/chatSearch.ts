import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export const CHAT_HISTORY_METHODS = {
  search: "chatHistory.search",
  read: "chatHistory.read",
  attachFinal: "chatHistory.attachFinal",
} as const;
export const CHAT_HISTORY_MESSAGE_PAGE_SIZE = 50;
export const CHAT_HISTORY_MESSAGE_TEXT_LIMIT = 8_000;
export const ChatHistorySource = Schema.Literals(["t3", "codex-app"]);
export const ChatHistoryTarget = Schema.Struct({
  source: ChatHistorySource,
  threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export const ChatHistoryReadInput = Schema.Struct({
  ...ChatHistoryTarget.fields,
  offset: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  ),
});
const DateBound = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.makeFilter((value) => {
    const date = DateTime.make(value);
    return Option.isSome(date) && DateTime.formatIso(date.value) === value;
  }),
);
export const ChatHistorySearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(200)),
  from: Schema.optionalKey(DateBound),
  before: Schema.optionalKey(DateBound),
  codexCursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
  t3Offset: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  ),
}).check(Schema.makeFilter((input) => !input.from || !input.before || input.from < input.before));
export type ChatHistorySearchInput = typeof ChatHistorySearchInput.Type;
export const ChatHistoryMatch = Schema.Struct({
  ...ChatHistoryTarget.fields,
  title: Schema.String,
  updatedAt: Schema.String,
  archived: Schema.Boolean,
  codexThreadId: Schema.NullOr(Schema.String),
  snippet: Schema.String,
});
export type ChatHistoryMatch = typeof ChatHistoryMatch.Type;
export const ChatHistoryCoverage = Schema.Struct({
  source: ChatHistorySource,
  status: Schema.Literals(["complete", "partial", "unavailable"]),
  detail: Schema.String,
  readGaps: Schema.optionalKey(Schema.Boolean),
});
export const ChatHistorySearchResult = Schema.Struct({
  matches: Schema.Array(ChatHistoryMatch),
  coverage: Schema.Array(ChatHistoryCoverage),
  nextCodexCursor: Schema.NullOr(Schema.String),
  nextT3Offset: Schema.NullOr(Schema.Int),
});
export type ChatHistorySearchResult = typeof ChatHistorySearchResult.Type;
export const ChatHistoryReadResult = Schema.Struct({
  title: Schema.String,
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      createdAt: Schema.NullOr(Schema.String),
    }),
  ),
  truncated: Schema.Boolean,
  nextOffset: Schema.NullOr(Schema.Int),
});
export type ChatHistoryReadResult = typeof ChatHistoryReadResult.Type;
export const ChatHistoryAttachFinalInput = Schema.Struct({
  threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  nativeTurnId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  expectedSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export const ChatHistoryAttachFinalResult = Schema.Struct({
  sequence: Schema.Int,
  messageId: Schema.String,
});
export class ChatHistoryError extends Schema.TaggedErrorClass<ChatHistoryError>()(
  "ChatHistoryError",
  { message: Schema.String },
) {}
