import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // This event type did not exist before migration 051. When there are no
  // compaction events, the empty projection is already correct at the tip.
  // If any exist, leave the cursor alone so normal replay handles them.
  yield* sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    SELECT
      'projection.thread-context-compactions',
      COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE NOT EXISTS (
      SELECT 1 FROM orchestration_events
      WHERE event_type IN (
        'thread.context-compaction-started',
        'thread.context-compaction-message-queued',
        'thread.context-compaction-status-changed',
        'thread.context-compaction-message-status-changed'
      )
    )
    ON CONFLICT (projector) DO UPDATE SET
      last_applied_sequence = excluded.last_applied_sequence,
      updated_at = excluded.updated_at
  `;
});
