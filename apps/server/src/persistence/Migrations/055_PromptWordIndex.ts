import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Rebuildable aggregate data only; authoritative messages remain untouched. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE usage_prompt_words_v1 (
    message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at TEXT NOT NULL,
    words INTEGER, characters INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_usage_prompt_words_v1_time
    ON usage_prompt_words_v1(created_at, message_id)`;
  yield* sql`CREATE TABLE usage_prompt_terms_v1 (
    message_id TEXT NOT NULL REFERENCES usage_prompt_words_v1(message_id) ON DELETE CASCADE,
    word TEXT NOT NULL, occurrences INTEGER NOT NULL, frequent INTEGER NOT NULL,
    PRIMARY KEY(word, message_id)
  )`;
  yield* sql`CREATE INDEX idx_usage_prompt_terms_v1_message ON usage_prompt_terms_v1(message_id)`;
  yield* sql`CREATE TABLE usage_prompt_pending_v1 (
    message_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1
  )`;
  yield* sql`INSERT INTO usage_prompt_pending_v1(message_id)
    SELECT message_id FROM projection_thread_messages WHERE role = 'user'`;
  yield* sql`CREATE TRIGGER usage_prompt_words_v1_inserted
    AFTER INSERT ON projection_thread_messages WHEN NEW.role = 'user'
    BEGIN
      INSERT INTO usage_prompt_pending_v1(message_id) VALUES (NEW.message_id);
    END`;
  yield* sql`CREATE TRIGGER usage_prompt_words_v1_changed
    AFTER UPDATE OF text, role, thread_id, created_at ON projection_thread_messages
    BEGIN
      DELETE FROM usage_prompt_terms_v1 WHERE message_id = OLD.message_id;
      DELETE FROM usage_prompt_words_v1 WHERE message_id = OLD.message_id;
      DELETE FROM usage_prompt_pending_v1 WHERE message_id = OLD.message_id AND NEW.role != 'user';
      INSERT INTO usage_prompt_pending_v1(message_id) SELECT NEW.message_id WHERE NEW.role = 'user'
        ON CONFLICT(message_id) DO UPDATE SET generation = generation + 1;
    END`;
  yield* sql`CREATE TRIGGER usage_prompt_words_v1_deleted
    AFTER DELETE ON projection_thread_messages
    BEGIN
      DELETE FROM usage_prompt_terms_v1 WHERE message_id = OLD.message_id;
      DELETE FROM usage_prompt_words_v1 WHERE message_id = OLD.message_id;
      DELETE FROM usage_prompt_pending_v1 WHERE message_id = OLD.message_id;
    END`;
});
