import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_context_compactions (
      thread_id TEXT NOT NULL,
      compact_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, compact_message_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_context_compaction_messages (
      thread_id TEXT NOT NULL,
      compact_message_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      request_order INTEGER NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      turn_start_json TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id),
      FOREIGN KEY (thread_id, compact_message_id)
        REFERENCES projection_thread_context_compactions(thread_id, compact_message_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_context_compaction_messages_order
    ON projection_thread_context_compaction_messages(thread_id, compact_message_id, request_order)
  `;
});
