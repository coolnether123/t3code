// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - offline maintenance, never imported by the server.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  retainEventPayload,
  retainToolPayload,
  restoreStoredPayload,
} from "../apps/server/src/persistence/ToolPayloadCodec.ts";

const floor = 20 * 1024 ** 3;
export function requireMaintenanceCapacity(available: number, databaseBytes: number): void {
  // Candidate divergence, rollback journal, and VACUUM output can each allocate a full file.
  if (
    !Number.isSafeInteger(available) ||
    !Number.isSafeInteger(databaseBytes) ||
    databaseBytes < 0 ||
    available - 3 * databaseBytes < floor
  )
    throw new Error(
      `T3 space guard: projected free below 20 GiB; available_bytes=${available}, allocation_bytes=${3 * databaseBytes}`,
    );
}

export function retainDatabasePayloads(db: NodeSqlite.DatabaseSync, restore = false) {
  const result = { events: 0, activities: 0, bytesBefore: 0, bytesAfter: 0 };
  const specifications = [
    {
      table: "orchestration_events",
      key: "sequence",
      filter: "event_type='thread.activity-appended'",
      event: true,
    },
    {
      table: "projection_thread_activities",
      key: "rowid",
      filter: "kind IN ('tool.completed','tool.updated')",
      event: false,
    },
  ];
  for (const spec of specifications) {
    let cursor = 0;
    const read = db.prepare(
      `SELECT ${spec.key} AS id, payload_json FROM ${spec.table} WHERE ${spec.key}>? AND ${spec.filter} ORDER BY ${spec.key} LIMIT 64`,
    );
    const update = db.prepare(`UPDATE ${spec.table} SET payload_json=? WHERE ${spec.key}=?`);
    while (true) {
      const rows = read.all(cursor) as { id: number; payload_json: string }[];
      if (!rows.length) break;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          cursor = row.id;
          const original = JSON.parse(row.payload_json) as unknown;
          const hydrated = restoreStoredPayload(original);
          const retained = restore
            ? hydrated
            : spec.event
              ? retainEventPayload("thread.activity-appended", hydrated)
              : retainToolPayload(hydrated);
          if (JSON.stringify(restoreStoredPayload(retained)) !== JSON.stringify(hydrated))
            throw new Error("Retention changed logical payload");
          const encoded = JSON.stringify(retained);
          // Already encoded rows and small rows remain untouched on repeated maintenance.
          if (
            encoded === row.payload_json ||
            (!restore && Buffer.byteLength(encoded) >= Buffer.byteLength(row.payload_json))
          )
            continue;
          update.run(encoded, row.id);
          result[spec.event ? "events" : "activities"]++;
          result.bytesBefore += Buffer.byteLength(row.payload_json);
          result.bytesAfter += Buffer.byteLength(encoded);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  return result;
}

function main(args: string[]) {
  if (args.length !== 3 || (args[0] !== "--execute" && args[0] !== "--restore"))
    throw new Error(
      "Usage: retain-tool-payloads.ts --execute|--restore <quiescent-private-candidate> <new-output>",
    );
  const input = NodeFS.realpathSync(args[1]!);
  const output = NodePath.resolve(args[2]!);
  const privateRoot = NodePath.join(process.env.HOME ?? "", "OtisPrivate", "rel-20261013", "t3-db");
  if (
    // oxlint-disable-next-line t3code/no-global-process-runtime -- standalone Darwin maintenance admission.
    process.platform !== "darwin" ||
    !input.startsWith(`${NodeFS.realpathSync(privateRoot)}${NodePath.sep}`) ||
    NodePath.dirname(output) !== NodePath.dirname(input) ||
    NodeFS.existsSync(output) ||
    NodeFS.lstatSync(args[1]!).isSymbolicLink() ||
    NodeFS.existsSync(`${input}-wal`)
  )
    throw new Error(
      "Maintenance requires a stopped, checkpointed private APFS candidate and a fresh sibling output",
    );
  const volume = NodeFS.statfsSync(NodePath.dirname(input));
  requireMaintenanceCapacity(volume.bavail * volume.bsize, NodeFS.statSync(input).size);
  const db = new NodeSqlite.DatabaseSync(input);
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    const counts = retainDatabasePayloads(db, args[0] === "--restore");
    const current = NodeFS.statfsSync(NodePath.dirname(input));
    requireMaintenanceCapacity(current.bavail * current.bsize, NodeFS.statSync(input).size);
    db.prepare("VACUUM INTO ?").run(output);
    const check = new NodeSqlite.DatabaseSync(output, { readOnly: true });
    try {
      if (
        (check.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
          .integrity_check !== "ok" ||
        check.prepare("PRAGMA foreign_key_check").all().length !== 0
      )
        throw new Error("Compacted candidate validation failed");
    } finally {
      check.close();
    }
    NodeFS.chmodSync(output, 0o600);
    const fd = NodeFS.openSync(output, "r");
    try {
      NodeFS.fsyncSync(fd);
    } finally {
      NodeFS.closeSync(fd);
    }
    const directory = NodeFS.openSync(NodePath.dirname(output), "r");
    try {
      NodeFS.fsyncSync(directory);
    } finally {
      NodeFS.closeSync(directory);
    }
    console.log(
      JSON.stringify({
        ...counts,
        candidateBytes: NodeFS.statSync(input).size,
        outputBytes: NodeFS.statSync(output).size,
        cutover: false,
      }),
    );
  } finally {
    db.close();
  }
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
