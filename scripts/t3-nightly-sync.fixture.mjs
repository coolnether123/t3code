import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { selectNightly, compareChecks } from "./t3-nightly-sync.mjs";
import { runNightly } from "./t3-nightly-sync.mjs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

NodeTest.test("already synced releases retain a durable deployment reconciliation request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-pending-"));
  try {
    fs.writeFileSync(path.join(root, "auto-deploy-enabled"), "");
    const config = path.join(root, "config.json");
    fs.writeFileSync(config, JSON.stringify({ repository: root, artifactRoot: root,
      releaseRoot: root, node: process.execPath, otisCall: "unused", taskId: "synthetic" }));
    const result = await runNightly(config, { run(exe, args) {
      NodeAssert.equal(exe, "git");
      let text = "";
      if (args[0] === "remote") text = `https://github.com/${args[2] === "origin" ? "coolnether123" : "pingdotgg"}/t3code.git`;
      if (args[0] === "ls-remote") text = "abc refs/tags/v0.1.8-nightly.20261106.4288";
      if (args[0] === "rev-parse") text = "abc";
      return { code: 0, text };
    } });
    NodeAssert.equal(result.result, "already-synced");
    NodeAssert.equal(result.deploymentPending, true);
    NodeAssert.equal(result.handoffState, "pending-parent-pickup");
    NodeAssert.equal(JSON.parse(fs.readFileSync(result.handoff, "utf8")).state, "pending-parent-pickup");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

NodeTest.test("hidden scheduler wrapper preserves child failure and success exits", () => {
  if (process.platform !== "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-exit-"));
  try {
    const child = path.join(root, "child.js");
    for (const code of [17, 0]) {
      fs.writeFileSync(child, `process.exit(${code});`);
      const result = spawnSync("cscript.exe", ["//B", "//Nologo", path.join(import.meta.dirname, "t3-nightly-run.vbs"), process.execPath, child, "synthetic"], { windowsHide: true });
      NodeAssert.equal(result.status, code, String(result.error ?? result.stderr));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
NodeTest.test("nightly selection sorts numeric sequence and ignores other tags", () => {
  NodeAssert.equal(
    selectNightly([
      "v0.1.3-nightly.20261024.99",
      "v0.1.3-nightly.20261024.100",
      "v9.0.0",
      "v0.1.3-nightly.20261023.999",
    ]),
    "v0.1.3-nightly.20261024.100",
  );
});
NodeTest.test("inherited failures require exact classified baseline evidence", () => {
  const failure = {
    name: "typecheck",
    exit: 1,
    classified: true,
    failures: ["TS123 exact diagnostic"],
  };
  NodeAssert.equal(compareChecks([failure], [failure]), true);
  NodeAssert.equal(compareChecks([failure], [{ ...failure, failures: ["different"] }]), false);
  NodeAssert.equal(compareChecks([{ ...failure, classified: false }], [failure]), false);
  NodeAssert.equal(compareChecks([{ ...failure, failures: [] }], [failure]), false);
  NodeAssert.equal(compareChecks([{ ...failure, exit: 0 }], []), true);
});
