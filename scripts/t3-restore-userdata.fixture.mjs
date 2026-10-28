import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { restoreOfflineUserdata } from "./t3-restore-userdata.mjs";
import { productionAdapter } from "./t3-deploy.mjs";
NodeTest.test("restores database and WAL together without replacing held userdata or logs", (t) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-restore-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const source = NodePath.join(root, "backup"),
    target = NodePath.join(root, "userdata");
  NodeFS.mkdirSync(source);
  NodeFS.mkdirSync(target);
  NodeFS.mkdirSync(NodePath.join(target, "logs"));
  NodeFS.writeFileSync(NodePath.join(target, "logs", "owner.log"), "retained owner log");
  NodeFS.writeFileSync(NodePath.join(target, "statev2.sqlite"), "candidate database");
  NodeFS.writeFileSync(NodePath.join(target, "statev2.sqlite-wal"), "candidate WAL");
  NodeFS.writeFileSync(NodePath.join(target, "candidate-only.sqlite"), "candidate-only database");
  NodeFS.writeFileSync(NodePath.join(source, "statev2.sqlite"), "previous database");
  NodeFS.writeFileSync(NodePath.join(source, "statev2.sqlite-wal"), "previous WAL");
  NodeFS.mkdirSync(NodePath.join(source, "logs"));
  NodeFS.writeFileSync(NodePath.join(source, "logs", "owner.log"), "old log");
  const identity = NodeFS.statSync(target).ino;
  const result = restoreOfflineUserdata(source, target);
  NodeAssert.equal(NodeFS.statSync(target).ino, identity);
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(target, "statev2.sqlite"), "utf8"),
    "previous database",
  );
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(target, "statev2.sqlite-wal"), "utf8"),
    "previous WAL",
  );
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(target, "logs", "owner.log"), "utf8"),
    "retained owner log",
  );
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(target, "candidate-only.sqlite")), false);
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(result.preserved, "candidate-only.sqlite"), "utf8"),
    "candidate-only database",
  );
});

for (let boundary = 1; boundary <= 5; boundary++) {
  NodeTest.test(
    `resumes offline junction recovery after rename ${boundary} with a fresh adapter`,
    async (t) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-restore-interrupted-"));
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
      const data = NodePath.join(root, "physical-userdata");
      const baseDir = NodePath.join(root, "home");
      const backupRoot = NodePath.join(root, "backups");
      const backup = NodePath.join(backupRoot, "snapshot-1");
      NodeFS.mkdirSync(data);
      NodeFS.mkdirSync(baseDir);
      NodeFS.symlinkSync(data, NodePath.join(baseDir, "userdata"), "junction");
      const source = NodePath.join(backup, "userdata");
      NodeFS.mkdirSync(source, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(backup, "snapshot.json"),
        JSON.stringify({ source: baseDir, offline: true, id: "snapshot-1" }),
      );
      for (const [name, value] of Object.entries({
        "statev2.sqlite": "snapshot database",
        "statev2.sqlite-wal": "snapshot WAL",
      })) {
        NodeFS.writeFileSync(NodePath.join(source, name), value);
        NodeFS.writeFileSync(NodePath.join(data, name), "failed " + value);
      }
      NodeFS.writeFileSync(NodePath.join(data, "candidate-only.sqlite"), "failed candidate only");
      const identity = NodeFS.statSync(data).ino;
      const config = { baseDir, backupRoot, releaseRoot: root };
      let renames = 0;
      const interrupted = productionAdapter(config, {
        renameUserdata: (from, to) => {
          NodeFS.renameSync(from, to);
          if (++renames === boundary) throw new Error("synthetic interruption");
        },
      });
      await NodeAssert.rejects(interrupted.restore(backup), /synthetic interruption/);
      const journal = JSON.parse(
        NodeFS.readFileSync(NodePath.join(backup, "restore-state.json"), "utf8"),
      );
      NodeAssert.equal(journal.data, NodeFS.realpathSync(data));
      await productionAdapter(config).restore(backup);
      NodeAssert.equal(
        NodeFS.realpathSync(NodePath.join(baseDir, "userdata")),
        NodeFS.realpathSync(data),
      );
      NodeAssert.equal(NodeFS.statSync(data).ino, identity);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(data, "statev2.sqlite"), "utf8"),
        "snapshot database",
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(data, "statev2.sqlite-wal"), "utf8"),
        "snapshot WAL",
      );
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(data, "candidate-only.sqlite")), false);
      for (const name of ["statev2.sqlite", "statev2.sqlite-wal", "candidate-only.sqlite"]) {
        NodeAssert.equal(
          NodeFS.readFileSync(NodePath.join(journal.failed, name), "utf8"),
          name === "candidate-only.sqlite"
            ? "failed candidate only"
            : "failed " + NodeFS.readFileSync(NodePath.join(source, name), "utf8"),
        );
      }
      NodeAssert.equal(
        JSON.parse(NodeFS.readFileSync(NodePath.join(backup, "restore-state.json"), "utf8")).phase,
        "complete",
      );
    },
  );
}
