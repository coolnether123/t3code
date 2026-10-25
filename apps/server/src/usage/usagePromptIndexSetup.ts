import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Rebuildable aggregate data only; authoritative messages remain untouched. */
export const setupUsagePromptIndex = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const installed =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'usage_prompt_words_v2_inserted'`;
      yield* sql`CREATE TABLE IF NOT EXISTS usage_prompt_words_v1 (
    message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at TEXT NOT NULL,
    words INTEGER, characters INTEGER NOT NULL
  )`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_usage_prompt_words_v1_time
    ON usage_prompt_words_v1(created_at, message_id)`;
      yield* sql`CREATE TABLE IF NOT EXISTS usage_prompt_terms_v1 (
    message_id TEXT NOT NULL REFERENCES usage_prompt_words_v1(message_id) ON DELETE CASCADE,
    word TEXT NOT NULL, occurrences INTEGER NOT NULL, frequent INTEGER NOT NULL,
    PRIMARY KEY(word, message_id)
  )`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_usage_prompt_terms_v1_message ON usage_prompt_terms_v1(message_id)`;
      yield* sql`CREATE TABLE IF NOT EXISTS usage_prompt_pending_v1 (
    message_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1
  )`;
      if (installed.length === 0) {
        // V1 counts may describe messages that changed during import into V2.
        yield* sql`DELETE FROM usage_prompt_terms_v1`;
        yield* sql`DELETE FROM usage_prompt_words_v1`;
        yield* sql`DELETE FROM usage_prompt_pending_v1`;
      }
      yield* sql`INSERT OR IGNORE INTO usage_prompt_pending_v1(message_id)
    SELECT message_id FROM usage_prompt_messages_v2 WHERE role = 'user' AND message_id NOT IN (SELECT message_id FROM usage_prompt_words_v1)`;
      yield* sql`CREATE TRIGGER IF NOT EXISTS usage_prompt_words_v2_inserted
    AFTER INSERT ON orchestration_v2_projection_messages WHEN NEW.role = 'user' AND json_extract(NEW.payload_json, '$.notification') IS NULL
    BEGIN
      INSERT INTO usage_prompt_pending_v1(message_id) VALUES (NEW.message_id);
    END`;
      yield* sql`CREATE TRIGGER IF NOT EXISTS usage_prompt_words_v2_changed
    AFTER UPDATE OF payload_json, role, thread_id, created_at ON orchestration_v2_projection_messages
    WHEN OLD.role IS NOT NEW.role OR OLD.thread_id IS NOT NEW.thread_id OR OLD.created_at IS NOT NEW.created_at
      OR json_extract(OLD.payload_json, '$.text') IS NOT json_extract(NEW.payload_json, '$.text')
      OR json_extract(OLD.payload_json, '$.notification') IS NOT json_extract(NEW.payload_json, '$.notification')
    BEGIN
      DELETE FROM usage_prompt_terms_v1 WHERE message_id = OLD.message_id;
      DELETE FROM usage_prompt_words_v1 WHERE message_id = OLD.message_id;
      DELETE FROM usage_prompt_pending_v1 WHERE message_id = OLD.message_id AND (NEW.role != 'user' OR json_extract(NEW.payload_json, '$.notification') IS NOT NULL);
      INSERT INTO usage_prompt_pending_v1(message_id) SELECT NEW.message_id WHERE NEW.role = 'user' AND json_extract(NEW.payload_json, '$.notification') IS NULL
        ON CONFLICT(message_id) DO UPDATE SET generation = generation + 1;
    END`;
      yield* sql`CREATE TRIGGER IF NOT EXISTS usage_prompt_words_v2_deleted
    AFTER DELETE ON orchestration_v2_projection_messages
    BEGIN
      DELETE FROM usage_prompt_terms_v1 WHERE message_id = OLD.message_id;
      DELETE FROM usage_prompt_words_v1 WHERE message_id = OLD.message_id;
      DELETE FROM usage_prompt_pending_v1 WHERE message_id = OLD.message_id;
    END`;
    }),
  );
});
