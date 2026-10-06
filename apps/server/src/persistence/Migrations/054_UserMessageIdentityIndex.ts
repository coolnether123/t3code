import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Covers the startup read of user-message identities. Without it SQLite walks
 * every message in thread order and visits each table row to check its role,
 * which on a cold page cache means one random read per message: minutes for a
 * few hundred thousand messages. The partial index holds only user messages.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_user_messages_thread_identity
    ON projection_thread_messages(thread_id, created_at, message_id, turn_id, updated_at)
    WHERE role = 'user'
  `;
});
