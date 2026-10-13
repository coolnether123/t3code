import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE approval_response_deliveries (
      thread_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      message_id TEXT NOT NULL,
      message_text TEXT NOT NULL,
      route TEXT,
      recorded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, request_id)
    )
  `;
});
