import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { installCliForwarder } from "./t3-cli-forward.mjs";

NodeTest.test(
  "the fixed relay route follows release switches and preserves JSON, stdin and exit status",
  (t) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-relay-synthetic-"));
    t.after(() => NodeFS.rmSync(root, { recursive: true }));
    const target = NodePath.join(root, "relay.mjs");
    NodeFS.writeFileSync(target, "original launcher");
    const config = NodePath.join(root, "config.json");
    NodeFS.writeFileSync(config, JSON.stringify({ releaseRoot: root, node: process.execPath }));
    installCliForwarder(config, target, NodePath.join(root, "backup"));
    for (const revision of ["old", "new"]) {
      const current = NodePath.join(root, revision);
      NodeFS.mkdirSync(NodePath.join(current, "apps/server/dist"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(current, "apps/server/dist/bin.mjs"),
        `import fs from 'node:fs';console.log(JSON.stringify({revision:${JSON.stringify(revision)},args:process.argv.slice(2),request:JSON.parse(fs.readFileSync(0,'utf8'))}));process.exitCode=7;`,
      );
      NodeFS.writeFileSync(NodePath.join(root, "state.json"), JSON.stringify({ current }));
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [target, "agent", "spaced argument"],
        {
          input: '{"kind":"snapshot"}',
          encoding: "utf8",
          windowsHide: true,
        },
      );
      NodeAssert.equal(result.status, 7);
      NodeAssert.deepEqual(JSON.parse(result.stdout), {
        revision,
        args: ["agent", "spaced argument"],
        request: { kind: "snapshot" },
      });
      NodeAssert.equal(result.stderr, "");
    }
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(root, "backup/relay-bin.mjs"), "utf8"),
      "original launcher",
    );
  },
);
