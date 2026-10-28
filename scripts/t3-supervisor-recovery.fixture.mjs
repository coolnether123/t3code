import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { recoverStartup, shouldRestartChild } from "./t3-supervisor.mjs";
NodeTest.test(
  "failed startup recovery records failure and starts current even with pending",
  async (t) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-synthetic-"));
    t.after(() => NodeFS.rmSync(root, { recursive: true }));
    const state = { current: root, pending: { id: "synthetic" } };
    NodeFS.writeFileSync(NodePath.join(root, "state.json"), JSON.stringify(state));
    for (const failure of ["owner EPERM", "recovery exit 1"]) {
      const started = [];
      await recoverStartup(
        { releaseRoot: root },
        async () => {
          throw new Error(failure);
        },
        async (selected) => started.push(selected),
      );
      NodeAssert.deepEqual(started, [root]);
      const receipt = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "last-recovery.json")));
      NodeAssert.equal(receipt.ok, false);
      NodeAssert.match(receipt.failure, new RegExp(failure));
    }
  },
);
NodeTest.test("pending cannot suppress restart of an unpaused crashed child", () => {
  NodeAssert.equal(shouldRestartChild(false, { exitCode: 1, signalCode: null }), true);
  NodeAssert.equal(shouldRestartChild(true, { exitCode: 1, signalCode: null }), false);
  NodeAssert.equal(shouldRestartChild(false, { exitCode: null, signalCode: null }), false);
});

NodeTest.test("fallback spawn failure is recorded without abandoning the owner", async (t) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-spawn-synthetic-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true }));
  NodeFS.writeFileSync(
    NodePath.join(root, "state.json"),
    JSON.stringify({ current: root, pending: { id: "synthetic" } }),
  );
  await recoverStartup(
    { releaseRoot: root },
    async () => {
      throw new Error("recovery failure");
    },
    async () => {
      throw new Error("spawn failure");
    },
  );
  const receipt = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "last-recovery.json")));
  NodeAssert.match(receipt.fallbackFailure, /spawn failure/);
  NodeAssert.equal(shouldRestartChild(false, undefined), true);
});
