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
import type { V2ThreadReadResponse__Thread } from "effect-codex-app-server/schema";
import { makeCodexDesktopDaemonStdio } from "./CodexDesktopDaemonTransport.ts";

function daemonMessages(thread: V2ThreadReadResponse__Thread) {
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
    limit: 20,
    sortKey: "updated_at",
    sourceKinds: [],
    modelProviders: [],
  });
  const needle = input.query.trim().toLocaleLowerCase();
  const matches: ChatHistoryMatch[] = [];
  let failed = false;
  let unknownDates = false;
  const histories = yield* Effect.forEach(
    page.data,
    (entry) =>
      client
        .request("thread/read", { threadId: entry.id, includeTurns: true })
        .pipe(Effect.timeout("5 seconds"), Effect.result),
    { concurrency: 4 },
  );
  for (const [index, result] of histories.entries()) {
    const readable = Result.isSuccess(result);
    failed ||= !readable;
    const thread = readable ? result.success.thread : page.data[index]!;
    const title = thread.name || thread.preview || "Untitled Codex chat";
    const updatedAt = DateTime.formatIso(DateTime.makeUnsafe(thread.updatedAt * 1000));
    const inRange = (date: string | null) =>
      date === null
        ? !input.from && !input.before
        : (!input.from || date >= input.from) && (!input.before || date < input.before);
    const messages = readable ? daemonMessages(thread) : [];
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
  const { thread } = yield* client.request("thread/read", { threadId, includeTurns: true });
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
  const stdio = yield* makeCodexDesktopDaemonStdio(homePath || undefined);
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
