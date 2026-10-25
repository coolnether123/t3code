import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import {
  initializeReleaseState,
  readReleaseState,
  ReleaseTransaction,
} from "./t3-release-state.mjs";

function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-fixture-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  initializeReleaseState(root, "old");
  const data = NodePath.join(root, "synthetic-data");
  NodeFS.writeFileSync(data, "old-schema");
  const calls = [];
  let child;
  const adapter = {
    async validate(candidate) {
      if (candidate === "missing") throw new Error("Missing dist/client");
    },
    async waitForIdle() {
      calls.push("idle");
    },
    async stop() {
      calls.push("stop");
      if (child) {
        const exited = NodeEvents.once(child, "exit");
        child.kill();
        await exited;
        child = undefined;
      }
    },
    async backup(id) {
      const file = NodePath.join(root, `${id}.backup`);
      NodeFS.copyFileSync(data, file);
      return file;
    },
    async restore(backup) {
      NodeFS.copyFileSync(backup, data);
    },
    async start(candidate) {
      calls.push(`start:${candidate}`);
      child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", 'process.send("ready"); process.on("message",()=>{});'],
        { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true },
      );
      await NodeEvents.once(child, "message");
      if (candidate !== "old") NodeFS.writeFileSync(data, "candidate-schema");
    },
    async health(candidate) {
      return { ok: candidate !== "broken", pid: child?.pid };
    },
  };
  t.after(async () => adapter.stop());
  return { root, data, calls, adapter, transaction: new ReleaseTransaction(root, adapter) };
}

NodeTest.test(
  "healthy candidate becomes current and preserves the last three good identities",
  async (t) => {
    const f = fixture(t);
    for (const candidate of ["one", "two", "three"]) {
      const receipt = await f.transaction.switchTo(candidate);
      NodeAssert.equal(receipt.result, "healthy");
      NodeAssert.ok(receipt.checks.pid);
    }
    NodeAssert.deepEqual(readReleaseState(f.root).good, ["three", "two", "one"]);
    NodeAssert.equal(readReleaseState(f.root).pending, null);
  },
);

NodeTest.test(
  "broken candidate stops, restores offline data, and proves the old process healthy",
  async (t) => {
    const f = fixture(t);
    const receipt = await f.transaction.switchTo("broken");
    NodeAssert.equal(receipt.result, "rolled-back");
    NodeAssert.notEqual(receipt.rollback.checks.pid, undefined);
    NodeAssert.equal(NodeFS.readFileSync(f.data, "utf8"), "old-schema");
    NodeAssert.equal(readReleaseState(f.root).current, "old");
    NodeAssert.deepEqual(f.calls, ["idle", "stop", "start:broken", "stop", "start:old"]);
  },
);

NodeTest.test("unfinished switch restores its snapshot and recovery is idempotent", async (t) => {
  const f = fixture(t);
  const backup = await f.adapter.backup("interrupted");
  NodeFS.writeFileSync(f.data, "candidate-schema");
  f.transaction.save({
    version: 1,
    current: "broken",
    good: ["old"],
    pending: { previous: "old", candidate: "broken", phase: "switching", backup },
  });
  NodeAssert.equal((await f.transaction.recover()).ok, true);
  NodeAssert.equal(NodeFS.readFileSync(f.data, "utf8"), "old-schema");
  NodeAssert.equal(readReleaseState(f.root).current, "old");
  NodeAssert.deepEqual(await f.transaction.recover(), { recovered: false });
});

NodeTest.test(
  "a killed switch owner releases its Windows lock and the next owner recovers",
  async (t) => {
    const f = fixture(t);
    const moduleUrl = new URL("./t3-release-state.mjs", import.meta.url).href;
    const program = `
    import * as NodeFS from 'node:fs';
    import * as NodePath from 'node:path';
    import { ReleaseTransaction } from ${JSON.stringify(moduleUrl)};
    const root = process.argv[1];
    const adapter = {
      validate: async () => {}, waitForIdle: async () => {}, stop: async () => {},
      backup: async () => { const p=NodePath.join(root,'crash.backup'); NodeFS.copyFileSync(NodePath.join(root,'synthetic-data'),p); return p; },
      start: async () => { NodeFS.writeFileSync(NodePath.join(root,'synthetic-data'),'new-schema'); process.send('switched'); await new Promise(()=>{}); },
    };
    process.on('message',()=>{});
    await new ReleaseTransaction(root,adapter).switchTo('broken');
  `;
    const owner = NodeChildProcess.spawn(
      process.execPath,
      ["--input-type=module", "-e", program, f.root],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    t.after(() => {
      if (owner.exitCode === null) owner.kill();
    });
    await Promise.race([
      NodeEvents.once(owner, "message"),
      NodeEvents.once(owner, "exit").then(([code]) => {
        throw new Error(`Switch fixture exited before reaching its interruption point: ${code}`);
      }),
    ]);
    const exited = NodeEvents.once(owner, "exit");
    owner.kill();
    await exited;
    NodeAssert.equal((await f.transaction.recover()).ok, true);
    NodeAssert.equal(NodeFS.readFileSync(f.data, "utf8"), "old-schema");
    NodeAssert.equal(readReleaseState(f.root).current, "old");
  },
);

NodeTest.test("failed rollback remains pending so a later supervisor can retry", async (t) => {
  const f = fixture(t);
  const original = f.adapter.health;
  f.adapter.health = async () => ({ ok: false });
  NodeAssert.equal((await f.transaction.switchTo("broken")).result, "rollback-failed");
  NodeAssert.equal(readReleaseState(f.root).pending.phase, "rolling-back");
  f.adapter.health = original;
  NodeAssert.equal((await f.transaction.recover()).ok, true);
});

NodeTest.test("missing client dist refuses before idle or process operations", async (t) => {
  const f = fixture(t);
  await NodeAssert.rejects(f.transaction.switchTo("missing"), /Missing dist/);
  NodeAssert.deepEqual(f.calls, []);
  NodeAssert.equal(readReleaseState(f.root).pending, null);
});

NodeTest.test("idle evidence failure leaves release and data unchanged", async (t) => {
  const f = fixture(t);
  f.adapter.waitForIdle = async () => {
    throw new Error("Open calls unknown");
  };
  await NodeAssert.rejects(f.transaction.switchTo("one"), /Open calls unknown/);
  NodeAssert.equal(readReleaseState(f.root).current, "old");
  NodeAssert.equal(NodeFS.readFileSync(f.data, "utf8"), "old-schema");
});

NodeTest.test("a concurrent owner is refused without changing its lock or state", async (t) => {
  const f = fixture(t);
  await f.transaction.exclusive(async () => {
    await NodeAssert.rejects(f.transaction.switchTo("one"), /EADDRINUSE/);
  });
  NodeAssert.equal(readReleaseState(f.root).current, "old");
});
