import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN sections_json TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN unsorted_section_collapsed INTEGER NOT NULL DEFAULT 0`;
});
