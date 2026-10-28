import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import { supervisorCommand } from "./t3-supervisor.mjs";
import { initializeReleaseState } from "./t3-release-state.mjs";
import { retainReleases } from "./t3-deploy.mjs";
NodeTest.test(
  "both supervisors acknowledge pause and replace only their captured children",
  async (t) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-supervisor-synthetic-"));
    const config = {
      releaseRoot: root,
      baseDir: root,
      node: process.execPath,
      fixtureLaunch: Object.fromEntries(
        ["server", "web"].map((mode) => [mode, { args: ["-e", "setInterval(()=>{},10000)"] }]),
      ),
    };
    initializeReleaseState(root, root);
    const file = NodePath.join(root, "config.json");
    NodeFS.writeFileSync(file, JSON.stringify(config));
    const supervisors = [];
    t.after(async () => {
      for (const [mode, child] of supervisors) {
        await supervisorCommand(config, mode, "stop");
        const exit = NodeEvents.once(child, "exit");
        child.kill();
        await exit;
      }
      NodeFS.rmSync(root, { recursive: true });
    });
    for (const mode of ["server", "web"]) {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodePath.join(import.meta.dirname, "t3-supervisor.mjs"), file, mode],
        { windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"] },
      );
      supervisors.push([mode, child]);
      await NodeEvents.once(child, "message");
      const before = await supervisorCommand(config, mode, "status");
      NodeAssert.ok(before.pid);
      const stopped = await supervisorCommand(config, mode, "stop");
      NodeAssert.equal(stopped.pid, null);
      NodeAssert.equal(stopped.paused, true);
      const after = await supervisorCommand(config, mode, "start", root);
      NodeAssert.ok(after.pid);
      NodeAssert.notEqual(after.pid, before.pid);
    }
  },
);
NodeTest.test(
  "retention deletes only receipted SHA folders outside the three good versions",
  (t) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-retention-synthetic-"));
    t.after(() => NodeFS.rmSync(root, { recursive: true }));
    const releases = ["a", "b", "c", "d"].map((c) => NodePath.join(root, c.repeat(40)));
    for (const dir of releases) {
      NodeFS.mkdirSync(dir);
      NodeFS.writeFileSync(
        NodePath.join(dir, "release.json"),
        JSON.stringify({ commit: NodePath.basename(dir) }),
      );
    }
    initializeReleaseState(root, releases[0]);
    const state = { version: 1, current: releases[0], good: releases.slice(0, 3), pending: null };
    NodeFS.writeFileSync(NodePath.join(root, "state.json"), JSON.stringify(state));
    NodeAssert.deepEqual(retainReleases(root), ["d".repeat(40)]);
    NodeAssert.ok(releases.slice(0, 3).every((r) => NodeFS.existsSync(r)));
  },
);

NodeTest.test(
  "failed recovery starts both owners and watchdog restarts current with pending",
  async (t) => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-recovery-process-synthetic-"),
    );
    const listener = NodeNet.createServer();
    listener.listen({
      path: `\\\\.\\pipe\\t3-fixture-${process.pid}`,
      readableAll: true,
      writableAll: true,
    });
    await NodeEvents.once(listener, "listening");
    const config = {
      releaseRoot: root,
      baseDir: root,
      node: process.execPath,
      fixtureLaunch: Object.fromEntries(
        ["server", "web"].map((mode) => [
          mode,
          {
            args: [
              "-e",
              `require('node:net').connect(${JSON.stringify(listener.address())});setInterval(()=>{},10000)`,
            ],
          },
        ]),
      ),
    };
    initializeReleaseState(root, root);
    const stateFile = NodePath.join(root, "state.json");
    const state = JSON.parse(NodeFS.readFileSync(stateFile));
    state.pending = { id: "synthetic-pending", previous: root, backup: null };
    NodeFS.writeFileSync(stateFile, JSON.stringify(state));
    const file = NodePath.join(root, "config.json");
    NodeFS.writeFileSync(file, JSON.stringify(config));
    const owners = [];
    const sockets = [];
    listener.on("connection", (socket) => sockets.push(socket));
    t.after(async () => {
      for (const [mode, owner] of owners) {
        await supervisorCommand(config, mode, "stop");
        const exited = NodeEvents.once(owner, "exit");
        owner.kill();
        await exited;
      }
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => listener.close(resolve));
      NodeFS.rmSync(root, { recursive: true });
    });
    for (const mode of ["server", "web"]) {
      const connected = NodeEvents.once(listener, "connection");
      const owner = NodeChildProcess.spawn(
        process.execPath,
        [NodePath.join(import.meta.dirname, "t3-supervisor.mjs"), file, mode],
        { windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"] },
      );
      owners.push([mode, owner]);
      await connected;
      const before = await supervisorCommand(config, mode, "status");
      NodeAssert.ok(before.pid);
      const restarted = NodeEvents.once(listener, "connection");
      process.kill(before.pid);
      await restarted;
      const after = await supervisorCommand(config, mode, "status");
      NodeAssert.ok(after.pid);
      NodeAssert.notEqual(after.pid, before.pid);
      NodeAssert.equal(after.release, root);
    }
    const receipt = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "last-recovery.json")));
    NodeAssert.equal(receipt.ok, false);
    NodeAssert.equal(receipt.pending.id, state.pending.id);
    NodeAssert.ok(JSON.parse(NodeFS.readFileSync(stateFile)).pending);
  },
);
