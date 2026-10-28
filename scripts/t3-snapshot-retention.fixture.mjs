import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { retainSnapshots } from "./t3-deploy.mjs";

function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-retention-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const backupRoot = NodePath.join(root, "snapshots");
  NodeFS.mkdirSync(backupRoot);
  const config = { releaseRoot: root, backupRoot, baseDir: NodePath.join(root, "data") };
  const state = { current: "new", good: ["new", "middle", "older"], pending: null };
  const save = () => NodeFS.writeFileSync(NodePath.join(root, "state.json"), JSON.stringify(state));
  save();
  const add = (id, previous, result = "healthy", finishedAt = "2026-10-25T00:00:00Z") => {
    const dir = NodePath.join(backupRoot, id);
    NodeFS.mkdirSync(dir);
    NodeFS.writeFileSync(
      NodePath.join(dir, "snapshot.json"),
      JSON.stringify({ id, source: config.baseDir, offline: true }),
    );
    NodeFS.writeFileSync(
      NodePath.join(root, `receipt-${id}.json`),
      JSON.stringify({ id, previous, result, finishedAt }),
    );
    return dir;
  };
  NodeFS.writeFileSync(
    NodePath.join(root, "last-deploy.json"),
    JSON.stringify({ result: "healthy", finishedAt: "2026-10-26T00:00:00Z", candidate: "new" }),
  );
  return { root, config, state, save, add };
}
NodeTest.test(
  "snapshot retention keeps three good releases, failed attempts and unknown snapshots",
  (t) => {
    const f = fixture(t);
    const kept = [
      f.add("latest", "new"),
      f.add("middle", "middle"),
      f.add("older", "older"),
      f.add("failed", "ancient", "rollback-failed"),
      f.add("unknown", "ancient", "unknown"),
      f.add("future", "ancient", "healthy", "2026-10-27T00:00:00Z"),
    ];
    const removed = f.add("obsolete", "ancient");
    NodeAssert.deepEqual(retainSnapshots(f.config), ["obsolete"]);
    NodeAssert.equal(NodeFS.existsSync(removed), false);
    NodeAssert.ok(kept.every((p) => NodeFS.existsSync(p)));
  },
);
NodeTest.test("pending and unsuccessful deploys never authorize snapshot deletion", (t) => {
  const f = fixture(t);
  const dir = f.add("obsolete", "ancient");
  f.state.pending = { id: "in-flight", backup: dir };
  f.save();
  NodeAssert.deepEqual(retainSnapshots(f.config), []);
  f.state.pending = null;
  f.save();
  NodeFS.writeFileSync(
    NodePath.join(f.root, "last-deploy.json"),
    JSON.stringify({ result: "rolled-back" }),
  );
  NodeAssert.deepEqual(retainSnapshots(f.config), []);
  NodeAssert.equal(NodeFS.existsSync(dir), true);
});
NodeTest.test("snapshot retention refuses a mismatched manifest", (t) => {
  const f = fixture(t);
  const dir = f.add("obsolete", "ancient");
  NodeFS.writeFileSync(
    NodePath.join(dir, "snapshot.json"),
    JSON.stringify({ id: "different", source: f.config.baseDir, offline: true }),
  );
  NodeAssert.throws(() => retainSnapshots(f.config), /identity/);
  NodeAssert.equal(NodeFS.existsSync(dir), true);
});
