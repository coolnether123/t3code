import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
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
