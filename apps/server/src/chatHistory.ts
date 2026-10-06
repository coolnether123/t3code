import {
  ChatHistoryError,
  CHAT_HISTORY_MESSAGE_PAGE_SIZE,
  CHAT_HISTORY_MESSAGE_TEXT_LIMIT,
  type ChatHistorySearchInput,
  type ChatHistorySearchResult,
  type ChatHistoryReadResult,
  type ChatHistoryMatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const SEARCH_RESULT_LIMIT = 50;

/** Search the projection directly, including archives, without loading thread runtime state. */
export const searchT3Chats = Effect.fn("searchT3Chats")(function* (input: ChatHistorySearchInput) {
  const sql = yield* SqlClient.SqlClient;
  const escapedQuery = input.query.trim().replace(/[!%_]/g, (character) => `!${character}`);
  const pattern = `%${escapedQuery}%`;
  const from = input.from ?? "";
  const before = input.before ?? "~";
  const rows = yield* sql<ChatHistoryMatch>`
    WITH candidates AS (
      SELECT t.thread_id, t.title, t.updated_at, t.archived_at,
        t.title AS snippet, 0 AS rank, t.updated_at AS matched_at
      FROM projection_threads t JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL
        AND t.title LIKE ${pattern} ESCAPE '!'
        AND t.updated_at >= ${from} AND t.updated_at < ${before}
      UNION ALL
      SELECT t.thread_id, t.title, t.updated_at, t.archived_at,
        m.text AS snippet, CASE m.role WHEN 'user' THEN 1 ELSE 2 END AS rank, m.created_at AS matched_at
      FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id = m.thread_id
        JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL AND m.is_streaming = 0
        AND (m.role = 'user' OR (m.role = 'assistant' AND m.message_id IN
          (SELECT assistant_message_id FROM projection_turns WHERE assistant_message_id IS NOT NULL)))
        AND m.text LIKE ${pattern} ESCAPE '!'
        AND m.created_at >= ${from} AND m.created_at < ${before}
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY rank, matched_at DESC) AS position
      FROM candidates
    )
    SELECT 't3' AS source, r.thread_id AS "threadId", title, r.updated_at AS "updatedAt",
      archived_at IS NOT NULL AS archived, substr(snippet, max(1, instr(lower(snippet), lower(${input.query.trim()})) - 60), 240) AS snippet,
      CASE WHEN s.provider_name = 'codex' THEN s.provider_thread_id ELSE NULL END AS "codexThreadId"
    FROM ranked r LEFT JOIN projection_thread_sessions s ON s.thread_id = r.thread_id
    WHERE position = 1 ORDER BY rank, r.updated_at DESC, r.thread_id LIMIT ${SEARCH_RESULT_LIMIT + 1} OFFSET ${input.t3Offset ?? 0}
  `;
  return {
    matches: rows
      .slice(0, SEARCH_RESULT_LIMIT)
      .map((row) => ({ ...row, archived: Boolean(row.archived) })),
    nextT3Offset:
      rows.length > SEARCH_RESULT_LIMIT ? (input.t3Offset ?? 0) + SEARCH_RESULT_LIMIT : null,
    coverage: [
      {
        source: "t3",
        status: rows.length > SEARCH_RESULT_LIMIT ? "partial" : "complete",
        detail:
          rows.length > SEARCH_RESULT_LIMIT
            ? "More T3 chats match. Search the next page to include them."
            : "Titles, user messages and completed assistant replies, including archived chats.",
      },
    ],
  } satisfies Pick<ChatHistorySearchResult, "matches" | "coverage" | "nextT3Offset">;
});

export const readT3Chat = Effect.fn("readT3Chat")(function* (threadId: string, offset = 0) {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* sql<{ title: string }>`SELECT t.title FROM projection_threads t
    JOIN projection_projects p ON p.project_id = t.project_id
    WHERE t.thread_id = ${threadId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
  if (!threads[0])
    return yield* new ChatHistoryError({ message: "This chat is no longer available." });
  const rows = yield* sql<{
    id: string;
    role: "user" | "assistant";
    text: string;
    createdAt: string;
    textLength: number;
  }>`
    SELECT message_id AS id, role, substr(text, 1, ${CHAT_HISTORY_MESSAGE_TEXT_LIMIT}) AS text, length(text) AS "textLength", created_at AS "createdAt"
    FROM projection_thread_messages WHERE thread_id = ${threadId} AND is_streaming = 0
      AND (role = 'user' OR (role = 'assistant' AND message_id IN
        (SELECT assistant_message_id FROM projection_turns WHERE assistant_message_id IS NOT NULL)))
    ORDER BY created_at DESC, message_id DESC LIMIT ${CHAT_HISTORY_MESSAGE_PAGE_SIZE + 1} OFFSET ${offset}`;
  return {
    title: threads[0].title,
    messages: rows
      .slice(0, CHAT_HISTORY_MESSAGE_PAGE_SIZE)
      .toReversed()
      .map((row) => ({ id: row.id, role: row.role, text: row.text, createdAt: row.createdAt })),
    truncated: rows
      .slice(0, CHAT_HISTORY_MESSAGE_PAGE_SIZE)
      .some((row) => row.textLength > CHAT_HISTORY_MESSAGE_TEXT_LIMIT),
    nextOffset:
      rows.length > CHAT_HISTORY_MESSAGE_PAGE_SIZE ? offset + CHAT_HISTORY_MESSAGE_PAGE_SIZE : null,
  } satisfies ChatHistoryReadResult;
});

export class ChatHistoryProjection extends Context.Service<
  ChatHistoryProjection,
  {
    readonly search: (
      input: ChatHistorySearchInput,
    ) => Effect.Effect<
      Pick<ChatHistorySearchResult, "matches" | "coverage" | "nextT3Offset">,
      import("effect/unstable/sql/SqlError").SqlError
    >;
    readonly read: (
      threadId: string,
      offset?: number,
    ) => Effect.Effect<
      ChatHistoryReadResult,
      import("effect/unstable/sql/SqlError").SqlError | ChatHistoryError
    >;
  }
>()("t3/chatHistory/ChatHistoryProjection") {}

export const layer = Layer.effect(
  ChatHistoryProjection,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return ChatHistoryProjection.of({
      search: (input) => searchT3Chats(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      read: (threadId, offset) =>
        readT3Chat(threadId, offset).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    });
  }),
);
