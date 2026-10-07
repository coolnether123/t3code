import {
  CHAT_HISTORY_MESSAGE_PAGE_SIZE,
  CHAT_HISTORY_MESSAGE_TEXT_LIMIT,
  type ChatHistorySearchInput,
  type ChatHistorySearchResult,
  type ChatHistoryReadResult,
  type ChatHistoryMatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import { makeCodexDesktopDaemonStdio } from "./CodexDesktopDaemonTransport.ts";

const ItemType = Schema.Struct({ type: Schema.String });
const TextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const UserItem = Schema.Struct({
  type: Schema.Literal("userMessage"),
  id: Schema.String,
  content: Schema.Array(Schema.Unknown),
});
const AssistantItem = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  id: Schema.String,
  text: Schema.String,
});
const HistoryTurn = Schema.Struct({
  status: Schema.String,
  startedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  items: Schema.Array(Schema.Unknown),
});
const HistoryResponse = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.String,
    name: Schema.optionalKey(Schema.NullOr(Schema.String)),
    preview: Schema.String,
    updatedAt: Schema.Number,
    turns: Schema.Array(HistoryTurn),
  }),
});

const decodeHistory = Schema.decodeUnknownEffect(HistoryResponse);
const decodeTurnsPage = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Array(HistoryTurn),
    nextCursor: Schema.NullOr(Schema.String),
  }),
);
const decodeItemType = Schema.decodeUnknownEffect(ItemType);
const decodeAssistant = Schema.decodeUnknownEffect(AssistantItem);
const decodeUser = Schema.decodeUnknownEffect(UserItem);
const decodeText = Schema.decodeUnknownEffect(TextContent);

/** Decode search text only. Tool payloads need neither validation nor copies. */
const readHistory = Effect.fn("readChatSearchHistory")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  threadId: string,
) {
  const request = (method: string, params: unknown) =>
    client.raw
      .request(method, params)
      .pipe(
        Effect.timeout("2 minutes"),
        Effect.retry({ times: 1, while: (error) => error._tag === "TimeoutError" }),
      );
  const response = yield* request("thread/read", { threadId, includeTurns: false }).pipe(
    Effect.flatMap(decodeHistory),
  );
  const turns: Array<{
    status: string;
    startedAt: number | null | undefined;
    items: ReadonlyArray<
      | typeof AssistantItem.Type
      | {
          type: "userMessage";
          id: string;
          content: ReadonlyArray<typeof TextContent.Type>;
        }
    >;
  }> = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: Effect.Success<ReturnType<typeof decodeTurnsPage>> = yield* request(
      "thread/turns/list",
      {
        threadId,
        limit: 1,
        itemsView: "full",
        sortDirection: "asc",
        ...(cursor ? { cursor } : {}),
      },
    ).pipe(Effect.flatMap(decodeTurnsPage));
    const searchTurns = yield* Effect.forEach(page.data, (turn) =>
      Effect.gen(function* () {
        const items = yield* Effect.forEach(turn.items, (raw) =>
          Effect.gen(function* () {
            const header = yield* decodeItemType(raw);
            if (header.type === "agentMessage") return yield* decodeAssistant(raw);
            if (header.type !== "userMessage") return null;
            const user = yield* decodeUser(raw);
            const content = yield* Effect.forEach(user.content, (part) =>
              Effect.gen(function* () {
                const header = yield* decodeItemType(part);
                return header.type === "text" ? yield* decodeText(part) : null;
              }),
            );
            return { ...user, content: content.filter((part) => part !== null) };
          }),
        );
        return {
          status: turn.status,
          startedAt: turn.startedAt,
          items: items.filter((item) => item !== null),
        };
      }),
    );
    turns.push(...searchTurns);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor))
      return yield* CodexErrors.CodexAppServerProtocolParseError.fromUnroutableMessage({
        type: "repeatedChatHistoryCursor",
      });
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { ...response.thread, turns };
});

function daemonMessages(thread: Effect.Success<ReturnType<typeof readHistory>>) {
  return thread.turns.flatMap((turn) =>
    turn.items.flatMap<ChatHistoryReadResult["messages"][number]>((item) => {
      const createdAt =
        turn.startedAt == null
          ? null
          : DateTime.formatIso(DateTime.makeUnsafe(turn.startedAt * 1000));
      if (item.type === "userMessage")
        return [
          {
            role: "user" as const,
            id: item.id,
            text: item.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n"),
            createdAt,
          },
        ];
      if (item.type === "agentMessage" && turn.status === "completed")
        return [{ id: item.id, role: "assistant" as const, text: item.text, createdAt }];
      return [];
    }),
  );
}

/** Only initialize, list and read are used. Never resume, import or start a turn. */
export const searchDaemonChats = Effect.fn("searchDaemonChats")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  input: ChatHistorySearchInput,
) {
  let archived = false;
  let cursor: string | null = null;
  if (input.codexCursor) {
    [archived, cursor] = yield* decodeDaemonCursor(input.codexCursor);
  }
  const page = yield* client.request("thread/list", {
    archived,
    cursor,
    limit: 1,
    sortKey: "updated_at",
    sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"],
    modelProviders: [],
  });
  const needle = input.query.trim().toLocaleLowerCase();
  const matches: ChatHistoryMatch[] = [];
  let failed = false;
  let unknownDates = false;
  const histories = yield* Effect.forEach(
    page.data,
    (entry) => readHistory(client, entry.id).pipe(Effect.result),
    { concurrency: 1 },
  );
  for (const [index, result] of histories.entries()) {
    const readable = Result.isSuccess(result);
    failed ||= !readable;
    const thread = readable ? result.success : page.data[index]!;
    const title = thread.name || thread.preview || "Untitled Codex chat";
    const updatedAt = DateTime.formatIso(DateTime.makeUnsafe(thread.updatedAt * 1000));
    const inRange = (date: string | null) =>
      date === null
        ? !input.from && !input.before
        : (!input.from || date >= input.from) && (!input.before || date < input.before);
    const messages = readable ? daemonMessages(result.success) : [];
    unknownDates ||=
      Boolean(input.from || input.before) &&
      messages.some(
        (message) =>
          message.createdAt === null && message.text.toLocaleLowerCase().includes(needle),
      );
    const message = messages.find(
      (message) => inRange(message.createdAt) && message.text.toLocaleLowerCase().includes(needle),
    );
    if ((inRange(updatedAt) && title.toLocaleLowerCase().includes(needle)) || message) {
      const text = message?.text ?? title;
      const index = Math.max(0, text.toLocaleLowerCase().indexOf(needle) - 60);
      matches.push({
        source: "codex-app",
        threadId: thread.id,
        codexThreadId: thread.id,
        title,
        updatedAt,
        archived,
        snippet: text.slice(index, index + 240),
      });
    }
  }
  const nextCodexCursor = page.nextCursor
    ? encodeDaemonCursor([archived, page.nextCursor])
    : archived
      ? null
      : encodeDaemonCursor([true, null]);
  return {
    matches,
    nextCodexCursor,
    coverage: [
      {
        source: "codex-app",
        readGaps: failed || unknownDates,
        status: failed || unknownDates || nextCodexCursor !== null ? "partial" : "complete",
        detail: failed
          ? "Some Codex histories could not be read. Results are incomplete."
          : unknownDates
            ? "Some matching messages have no date. Date-filtered results are incomplete."
            : nextCodexCursor !== null
              ? "More Codex chats remain. Search the next page to include them."
              : "Codex daemon user messages and assistant replies in completed turns searched. Tool output is excluded.",
      },
    ],
  } satisfies Omit<ChatHistorySearchResult, "nextT3Offset">;
});

export const readDaemonChat = Effect.fn("readDaemonChat")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  threadId: string,
  offset = 0,
) {
  const thread = yield* readHistory(client, threadId);
  const messages = daemonMessages(thread);
  const end = Math.max(0, messages.length - offset);
  const start = Math.max(0, end - CHAT_HISTORY_MESSAGE_PAGE_SIZE);
  const page = messages.slice(start, end);
  return {
    title: thread.name || thread.preview || "Untitled Codex chat",
    messages: page.map((message) => ({
      ...message,
      text: message.text.slice(0, CHAT_HISTORY_MESSAGE_TEXT_LIMIT),
    })),
    truncated: page.some((message) => message.text.length > CHAT_HISTORY_MESSAGE_TEXT_LIMIT),
    nextOffset: start > 0 ? offset + CHAT_HISTORY_MESSAGE_PAGE_SIZE : null,
  } satisfies ChatHistoryReadResult;
});

export const withChatDaemon = Effect.fn("withChatDaemon")(function* <A, E>(
  homePath: string,
  use: (client: CodexClient.CodexAppServerClient["Service"]) => Effect.Effect<A, E>,
) {
  // Tool-heavy histories can exceed ws's 100 MB default. Search reads one at a
  // time, with a separate frame bound; normal provider connections are unchanged.
  const stdio = yield* makeCodexDesktopDaemonStdio(
    homePath || undefined,
    undefined,
    undefined,
    512 * 1024 * 1024,
  );
  return yield* Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    yield* client.request("initialize", {
      clientInfo: { name: "t3-chat-search", title: "T3 chat search", version: "0" },
      capabilities: { experimentalApi: true },
    });
    yield* client.notify("initialized", undefined);
    return yield* use(client);
  }).pipe(Effect.provide(CodexClient.layer(stdio)));
});

const DaemonCursor = Schema.fromJsonString(
  Schema.Tuple([Schema.Boolean, Schema.NullOr(Schema.String)]),
);
const encodeDaemonCursor = Schema.encodeSync(DaemonCursor);
const decodeDaemonCursor = Schema.decodeUnknownEffect(DaemonCursor);
