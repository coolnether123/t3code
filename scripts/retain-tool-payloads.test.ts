// @effect-diagnostics nodeBuiltinImport:off - disposable SQLite retention/backup fixtures.
import * as NodeSqlite from "node:sqlite";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { retainDatabasePayloads, requireMaintenanceCapacity } from "./retain-tool-payloads.ts";
import { restoreStoredPayload } from "../apps/server/src/persistence/ToolPayloadCodec.ts";

describe("offline replay-safe retention", () => {
  it("compacts a disposable database and restores its original logical tool history", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-synthetic-retention-"));
    const output = NodePath.join(root, "compacted.sqlite");
    const db = new NodeSqlite.DatabaseSync(NodePath.join(root, "candidate.sqlite"));
    try {
      db.exec(
        "CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_type TEXT,payload_json TEXT); CREATE TABLE projection_thread_activities(activity_id TEXT PRIMARY KEY,kind TEXT,payload_json TEXT)",
      );
      const payload = {
        detail: "synthetic",
        data: { content: "synthetic old tool result\n".repeat(40000) },
      };
      const event = { activity: { kind: "tool.completed", payload } };
      db.prepare("INSERT INTO orchestration_events VALUES(1,'thread.activity-appended',?)").run(
        JSON.stringify(event),
      );
      db.prepare(
        "INSERT INTO projection_thread_activities VALUES('activity-1','tool.completed',?)",
      ).run(JSON.stringify(payload));
      const before = (await NodeFSP.stat(NodePath.join(root, "candidate.sqlite"))).size;
      retainDatabasePayloads(db);
      db.prepare("VACUUM INTO ?").run(output);
      const check = new NodeSqlite.DatabaseSync(output, { readOnly: true });
      try {
        const row = check.prepare("SELECT payload_json FROM orchestration_events").get() as {
          payload_json: string;
        };
        expect(restoreStoredPayload(JSON.parse(row.payload_json))).toEqual(event);
        expect(check.prepare("PRAGMA integrity_check").get()).toMatchObject({
          integrity_check: "ok",
        });
        expect((await NodeFSP.stat(output)).size).toBeLessThan(before / 10);
      } finally {
        check.close();
      }
    } finally {
      db.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("rolls back the current maintenance batch when a later payload is corrupt", () => {
    const db = new NodeSqlite.DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_type TEXT,payload_json TEXT); CREATE TABLE projection_thread_activities(activity_id TEXT PRIMARY KEY,kind TEXT,payload_json TEXT)",
      );
      const first = JSON.stringify({
        activity: { kind: "tool.completed", payload: { data: "synthetic\n".repeat(10000) } },
      });
      db.prepare("INSERT INTO orchestration_events VALUES(1,'thread.activity-appended',?)").run(
        first,
      );
      db.prepare("INSERT INTO orchestration_events VALUES(2,'thread.activity-appended',?)").run(
        JSON.stringify({
          activity: {
            kind: "tool.completed",
            payload: { data: { __t3CompressedToolDataV1: { codec: "corrupt" } } },
          },
        }),
      );
      expect(() => retainDatabasePayloads(db)).toThrow("Invalid retained");
      expect(
        db.prepare("SELECT payload_json FROM orchestration_events WHERE sequence=1").get(),
      ).toMatchObject({ payload_json: first });
    } finally {
      db.close();
    }
  });
  it("preserves identities, lifecycle state and every logical payload through retention and restoration", () => {
    const db = new NodeSqlite.DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY, event_type TEXT, payload_json TEXT, stream_version INTEGER);
        CREATE TABLE projection_thread_activities(activity_id TEXT PRIMARY KEY, kind TEXT, payload_json TEXT);
        CREATE TABLE protected_state(kind TEXT, value TEXT);
        INSERT INTO protected_state VALUES ('approval','pending'),('input','pending'),('provider','resume-id'),('receipt','deduplicated'),('message','original');`);
      const payload = {
        requestId: "request-1",
        detail: "synthetic",
        data: { content: "synthetic tool output\n".repeat(20000) },
      };
      const event = { activity: { kind: "tool.completed", payload } };
      db.prepare("INSERT INTO orchestration_events VALUES(1,?, ?,7)").run(
        "thread.activity-appended",
        JSON.stringify(event),
      );
      db.prepare("INSERT INTO orchestration_events VALUES(2,?, ?,8)").run(
        "thread.message-sent",
        JSON.stringify({ text: "original synthetic final" }),
      );
      db.prepare("INSERT INTO projection_thread_activities VALUES(?,?,?)").run(
        "activity-1",
        "tool.completed",
        JSON.stringify(payload),
      );
      db.prepare("INSERT INTO projection_thread_activities VALUES(?,?,?)").run(
        "approval-1",
        "approval.requested",
        JSON.stringify(payload),
      );
      const protectedBefore = db.prepare("SELECT * FROM protected_state").all();
      expect(retainDatabasePayloads(db)).toMatchObject({ events: 1, activities: 1 });
      const stored = db.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all() as {
        payload_json: string;
        sequence: number;
        stream_version: number;
      }[];
      expect(restoreStoredPayload(JSON.parse(stored[0]!.payload_json))).toEqual(event);
      expect(stored.map((x) => [x.sequence, x.stream_version])).toEqual([
        [1, 7],
        [2, 8],
      ]);
      expect(JSON.parse(stored[1]!.payload_json)).toEqual({ text: "original synthetic final" });
      expect(db.prepare("SELECT * FROM protected_state").all()).toEqual(protectedBefore);
      expect(retainDatabasePayloads(db)).toMatchObject({ events: 0, activities: 0 });
      expect(retainDatabasePayloads(db, true)).toMatchObject({ events: 1, activities: 1 });
      expect(
        JSON.parse(
          (
            db.prepare("SELECT payload_json FROM orchestration_events WHERE sequence=1").get() as {
              payload_json: string;
            }
          ).payload_json,
        ),
      ).toEqual(event);
    } finally {
      db.close();
    }
  });
  it("reserves candidate divergence, journal and output above the 20 GiB floor", () => {
    const giB = 1024 ** 3;
    expect(() => requireMaintenanceCapacity(30 * giB, 12 * giB)).toThrow("projected free");
    expect(() => requireMaintenanceCapacity(56 * giB, 12 * giB)).not.toThrow();
  });
});
