import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";

function writeJson(file, value) {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  const fd = NodeFS.openSync(temporary, "wx");
  try {
    NodeFS.writeFileSync(fd, JSON.stringify(value, null, 2));
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
  NodeFS.renameSync(temporary, file);
}

export function readReleaseState(root) {
  return JSON.parse(NodeFS.readFileSync(NodePath.join(root, "state.json"), "utf8"));
}

export function initializeReleaseState(root, release) {
  NodeFS.mkdirSync(root, { recursive: true });
  const file = NodePath.join(root, "state.json");
  if (NodeFS.existsSync(file)) throw new Error("Release state already exists");
  writeJson(file, { version: 1, current: release, good: [release], pending: null });
}

// The adapter owns service shutdown, offline data snapshots, and runtime proof.
// Keeping the journal separate permits the supervisor to recover without a CLI.
export class ReleaseTransaction {
  constructor(root, adapter) {
    this.root = NodeFS.realpathSync(root);
    this.adapter = adapter;
  }

  save(state) {
    writeJson(NodePath.join(this.root, "state.json"), state);
  }

  receipt(value) {
    writeJson(NodePath.join(this.root, `receipt-${value.id}.json`), value);
    writeJson(NodePath.join(this.root, "last-deploy.json"), value);
  }

  async exclusive(operation) {
    // Windows releases named pipes when their owner dies, including on reboot.
    // A sentinel file would strand recovery behind the crashed deploy's lock.
    // oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone maintenance command has no Effect runtime.
    if (process.platform !== "win32") throw new Error("Release switching requires Windows");
    const key = NodeCrypto.createHash("sha256").update(this.root.toLowerCase()).digest("hex");
    const lock = NodeNet.createServer((socket) => socket.destroy());
    const listening = NodeEvents.once(lock, "listening");
    lock.listen(`\\\\.\\pipe\\t3-release-${key}`);
    await listening;
    try {
      return await operation();
    } finally {
      await new Promise((resolve, reject) =>
        lock.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }

  async switchTo(candidate) {
    return this.exclusive(async () => {
      const state = readReleaseState(this.root);
      if (state.pending) throw new Error("Interrupted switch requires recovery first");
      await this.adapter.validate(candidate);
      await this.adapter.waitForIdle();
      const receipt = {
        id: NodeCrypto.randomUUID(),
        candidate,
        previous: state.current,
        startedAt: new Date().toISOString(),
        checks: null,
        rollback: null,
      };
      const previousGood = [...state.good];
      let backupForRollback = null;
      state.pending = { ...receipt, phase: "stopping", backup: null };
      this.save(state);
      try {
        await this.adapter.stop();
        state.pending.backup = await this.adapter.backup(receipt.id);
        backupForRollback = state.pending.backup;
        state.pending.phase = "switching";
        this.save(state);
        state.current = candidate;
        this.save(state);
        await this.adapter.start(candidate);
        receipt.checks = await this.adapter.health(candidate);
        if (receipt.checks.ok !== true) throw new Error("Candidate health failed");
        receipt.result = "healthy";
        receipt.finishedAt = new Date().toISOString();
        this.receipt(receipt);
        state.good = [candidate, ...state.good.filter((value) => value !== candidate)].slice(0, 3);
        state.pending = null;
        this.save(state);
      } catch (error) {
        // A failed final state write must still have the previous snapshot.
        state.pending ??= { ...receipt, phase: "rolling-back", backup: backupForRollback };
        state.good = previousGood;
        receipt.failure = String(error);
        receipt.rollback = await this.rollback(state);
        receipt.result = receipt.rollback.ok ? "rolled-back" : "rollback-failed";
        receipt.finishedAt = new Date().toISOString();
        this.receipt(receipt);
      }
      return receipt;
    });
  }

  async rollback(state) {
    const pending = state.pending;
    try {
      // Persist before touching data. A repeated recovery restores the same snapshot.
      pending.phase = "rolling-back";
      this.save(state);
      await this.adapter.stop();
      if (pending.backup !== null) await this.adapter.restore(pending.backup);
      state.current = pending.previous;
      this.save(state);
      await this.adapter.start(state.current);
      const checks = await this.adapter.health(state.current);
      if (checks.ok !== true) throw new Error("Previous release health failed");
      state.pending = null;
      this.save(state);
      return { ok: true, checks };
    } catch (error) {
      return { ok: false, failure: String(error) };
    }
  }

  async recover() {
    return this.exclusive(async () => {
      const state = readReleaseState(this.root);
      if (!state.pending) return { recovered: false };
      const result = await this.rollback(state);
      const receipt = { recovered: true, ...result, at: new Date().toISOString() };
      writeJson(NodePath.join(this.root, "last-recovery.json"), receipt);
      return receipt;
    });
  }
}
