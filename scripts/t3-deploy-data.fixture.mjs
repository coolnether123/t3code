import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import { productionAdapter } from "./t3-deploy.mjs";

NodeTest.test(
  "offline rollback restores a real SQLite schema and retains the failed candidate data",
  async (t) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-offline-sqlite-synthetic-"));
    t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
    const baseDir = NodePath.join(root, "synthetic-home");
    const userdata = NodePath.join(baseDir, "userdata");
    NodeFS.mkdirSync(userdata, { recursive: true });
    const dbPath = NodePath.join(userdata, "statev2.sqlite");
    const original = new NodeSqlite.DatabaseSync(dbPath);
    original.exec(
      "CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('old'); PRAGMA user_version=1;",
    );
    original.close();
    const adapter = productionAdapter(
      { baseDir, backupRoot: NodePath.join(root, "backups") },
      {
        owners: async () => ["server", "web"].map((mode) => ({ mode, paused: true, pid: null })),
        observe: (operation) => operation(),
      },
    );
    await adapter.stop();
    const backup = await adapter.backup("synthetic-backup");
    const candidate = new NodeSqlite.DatabaseSync(dbPath);
    candidate.exec(
      "CREATE TABLE candidate_only(value TEXT); INSERT INTO records VALUES ('candidate'); PRAGMA user_version=2;",
    );
    candidate.close();
    const marker = NodePath.join(backup, "snapshot.json");
    const manifest = JSON.parse(NodeFS.readFileSync(marker, "utf8"));
    NodeFS.writeFileSync(marker, JSON.stringify({ ...manifest, offline: false }));
    await NodeAssert.rejects(adapter.restore(backup), /identity mismatch/);
    NodeFS.writeFileSync(marker, JSON.stringify(manifest));
    await adapter.restore(backup);
    const restored = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    NodeAssert.equal(restored.prepare("PRAGMA user_version").get().user_version, 1);
    NodeAssert.deepEqual(
      restored
        .prepare("SELECT value FROM records")
        .all()
        .map((row) => row.value),
      ["old"],
    );
    NodeAssert.deepEqual(
      restored
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
      ["records"],
    );
    restored.close();
    const failed = NodeFS.readdirSync(baseDir).find((name) => name.startsWith("userdata.failed-"));
    NodeAssert.ok(failed);
    const retained = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, failed, "statev2.sqlite"), {
      readOnly: true,
    });
    NodeAssert.equal(retained.prepare("PRAGMA user_version").get().user_version, 2);
    retained.close();
  },
);
