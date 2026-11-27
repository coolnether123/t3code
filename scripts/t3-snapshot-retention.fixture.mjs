import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { productionAdapter } from "./t3-deploy.mjs";
import { ReleaseTransaction, readReleaseState } from "./t3-release-state.mjs";

function fixture(t) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-retention-synthetic-"));
  t.after(() => NodeFS.rmSync(home, { recursive: true, force: true }));
  const root = NodePath.join(home, "releases");
  const legacy = NodePath.join(root, "data-backups");
  const backupRoot = NodePath.join(home, "backups");
  NodeFS.mkdirSync(legacy, { recursive: true });
  NodeFS.mkdirSync(backupRoot);
  const config = { releaseRoot: root, backupRoot, baseDir: NodePath.join(home, "protected-data") };
  const release = (name) => NodePath.join(root, name.repeat(40));
  const [current, previous, third, older] = ["a", "b", "c", "d"].map(release);
  const state = { version: 1, current, good: [current, previous, third], pending: null };
  const write = (file, value) => NodeFS.writeFileSync(file, JSON.stringify(value));
  for (const dir of [current, previous, third, older, release("e")]) {
    NodeFS.mkdirSync(dir);
    write(NodePath.join(dir, "release.json"), {
      commit: NodePath.basename(dir),
      root: dir,
      liveDataUsed: false,
      preparedAt: "2026-11-01T00:00:00Z",
    });
  }
  let serving = current;
  const transaction = new ReleaseTransaction(
    root,
    productionAdapter(config, {
      owners: async (command) => {
        NodeAssert.equal(command, "status");
        return ["server", "web"].map((mode) => ({ mode, pid: 123, release: serving }));
      },
    }),
  );
  transaction.save(state);
  const day = (date, hour) => `2026-11-${date}T0${hour}:00:00Z`;
  const add = (date, candidate, previous, backupRoot, result = "healthy") => {
    const id = `00000000-0000-4000-8000-0000000000${date}`;
    const dir = NodePath.join(backupRoot, id);
    const userdata = NodePath.join(dir, "userdata");
    NodeFS.mkdirSync(userdata, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(userdata, "statev2.sqlite"), "SQLite format 3\0");
    write(NodePath.join(dir, "snapshot.json"), { id, source: config.baseDir, offline: true });
    if (result === "rolled-back") {
      const data = NodePath.join(config.baseDir, "userdata");
      write(NodePath.join(dir, "restore-state.json"), {
        version: 1,
        source: userdata,
        data,
        staged: `${data}.restore-${id}`,
        failed: `${data}.failed-${id}`,
        phase: "complete",
      });
    }
    const receipt = {
      id,
      candidate,
      commit: NodePath.basename(candidate),
      previous,
      startedAt: day(date, 1),
      finishedAt: day(date, 2),
      result,
      checks: result === "healthy" ? { ok: true } : null,
      rollback: result === "rolled-back" ? { ok: true, checks: { ok: true } } : null,
    };
    write(NodePath.join(root, `receipt-${id}.json`), receipt);
    return { dir, receipt };
  };
  const newest = add(20, current, previous, backupRoot);
  const second = add(19, previous, third, legacy);
  const obsolete = add(18, third, older, backupRoot);
  const lastFile = NodePath.join(root, "last-deploy.json");
  write(lastFile, newest.receipt);
  return {
    root,
    config,
    legacy,
    state,
    transaction,
    release,
    add,
    write,
    current,
    previous,
    third,
    newest,
    second,
    obsolete,
    lastFile,
    setServing: (dir) => {
      serving = dir;
    },
  };
}

NodeTest.test(
  "retention ranks snapshots across both roots and reconciles an exact third release",
  async (t) => {
    const f = fixture(t);
    const rolledBack = f.add(17, f.release("e"), f.release("d"), f.legacy, "rolled-back");
    const failed = f.add(16, f.release("f"), f.release("d"), f.legacy, "rollback-failed");
    const interrupted = f.add(15, f.release("f"), f.release("d"), f.legacy, "rolled-back");
    const journal = NodePath.join(interrupted.dir, "restore-state.json");
    f.write(journal, { ...JSON.parse(NodeFS.readFileSync(journal)), phase: "installing" });
    const building = NodePath.join(f.root, ".building-active");
    NodeFS.mkdirSync(building);
    const retireRelease = NodePath.basename(f.third);
    const options = { retireRelease };
    const preview = await f.transaction.retain({ ...options, dryRun: true });
    NodeAssert.deepEqual(
      preview.snapshots.eligible.sort(),
      [f.obsolete.dir, rolledBack.dir].sort(),
    );
    NodeAssert.deepEqual(preview.releases.eligible, [f.third]);
    NodeAssert.equal(NodeFS.existsSync(f.obsolete.dir), true);
    NodeAssert.deepEqual(readReleaseState(f.root).good, f.state.good);
    const result = await f.transaction.retain(options);
    NodeAssert.deepEqual(result.releases.deleted, [f.third]);
    NodeAssert.deepEqual(result.snapshots.deleted.sort(), [f.obsolete.dir, rolledBack.dir].sort());
    NodeAssert.ok(
      [
        f.current,
        f.previous,
        f.newest.dir,
        f.second.dir,
        failed.dir,
        interrupted.dir,
        building,
        f.release("e"),
      ].every((dir) => NodeFS.existsSync(dir)),
    );
    NodeAssert.deepEqual(readReleaseState(f.root).good, [f.current, f.previous]);
    NodeAssert.equal(JSON.parse(NodeFS.readFileSync(f.lastFile)).id, f.newest.receipt.id);
    NodeAssert.equal(
      NodeFS.existsSync(NodePath.join(f.root, `receipt-${rolledBack.receipt.id}.json`)),
      true,
    );
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(f.root, `receipt-${result.id}.json`)), true);
    NodeAssert.equal(result.snapshots.restoreEvidence[0].journal.phase, "complete");
  },
);

NodeTest.test("pending, concurrent or off-current readers prevent reconciliation", async (t) => {
  const f = fixture(t);
  f.state.pending = { backup: f.obsolete.dir };
  f.transaction.save(f.state);
  await NodeAssert.rejects(f.transaction.retain(), /pending|recovery/i);
  f.state.pending = null;
  f.transaction.save(f.state);
  await f.transaction.exclusive(async () => {
    await NodeAssert.rejects(f.transaction.retain(), /EADDRINUSE/);
  });
  f.setServing(f.third);
  await NodeAssert.rejects(
    f.transaction.retain({ retireRelease: NodePath.basename(f.third) }),
    /serving|supervisors/i,
  );
  NodeAssert.ok([f.obsolete.dir, f.third].every((dir) => NodeFS.existsSync(dir)));
  NodeAssert.deepEqual(readReleaseState(f.root).good, f.state.good);
});

NodeTest.test(
  "duplicate IDs and junctions cannot count toward two newer restore points",
  async (t) => {
    const f = fixture(t);
    const duplicate = NodePath.join(f.legacy, f.newest.receipt.id);
    NodeFS.symlinkSync(f.newest.dir, duplicate, "junction");
    const linked = NodePath.join(f.obsolete.dir, "userdata", "junction");
    NodeFS.symlinkSync(f.second.dir, linked, "junction");
    const result = await f.transaction.retain();
    NodeAssert.deepEqual(result.snapshots.deleted, []);
    NodeAssert.equal(NodeFS.lstatSync(duplicate).isSymbolicLink(), true);
    NodeAssert.equal(NodeFS.lstatSync(linked).isSymbolicLink(), true);
    NodeAssert.ok(NodeFS.existsSync(f.second.dir));
  },
);

NodeTest.test("retirement holds a rebuilt SHA or a release containing a junction", async (t) => {
  const f = fixture(t);
  const receipt = NodePath.join(f.third, "release.json");
  const prepared = JSON.parse(NodeFS.readFileSync(receipt));
  f.write(receipt, { ...prepared, preparedAt: "2026-11-19T00:00:00Z" });
  const options = { retireRelease: NodePath.basename(f.third) };
  let result = await f.transaction.retain(options);
  NodeAssert.equal(result.ok, false);
  NodeAssert.match(result.releases.held[0].reason, /historical healthy deployment/);
  f.write(receipt, prepared);
  const dependency = NodePath.join(f.third, "node_modules", "external");
  NodeFS.mkdirSync(NodePath.dirname(dependency));
  NodeFS.symlinkSync(f.current, dependency, "junction");
  result = await f.transaction.retain(options);
  NodeAssert.equal(result.ok, false);
  NodeAssert.match(result.releases.held[0].reason, /contains a link/);
  NodeAssert.ok(NodeFS.lstatSync(dependency).isSymbolicLink());
  NodeAssert.deepEqual(readReleaseState(f.root).good, f.state.good);
});
