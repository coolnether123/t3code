import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { restoreOfflineUserdata } from "./t3-restore-userdata.mjs";
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
