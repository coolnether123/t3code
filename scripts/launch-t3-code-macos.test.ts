import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";

const scriptPath = NodePath.join(
  NodePath.dirname(fileURLToPath(import.meta.url)),
  "launch-t3-code-macos.sh",
);

const source = NodeFS.readFileSync(scriptPath, "utf8");

describe("launch-t3-code-macos", () => {
  it("is valid bash without executing the deployment", () => {
    NodeChildProcess.execFileSync("/bin/bash", ["-n", scriptPath]);
  });

  it("requires a pinned source and explicit backup boundary", () => {
    assert.include(source, "--expected-commit");
    assert.include(source, "--backup-root");
    assert.include(source, "source commit is $actual, expected $EXPECTED_COMMIT");
    assert.include(source, "source checkout has uncommitted changes");
  });

  it("uses scoped process ownership and consistent SQLite backup", () => {
    assert.include(source, "ps -axo pid=,command=");
    assert.include(source, "ps -axo pid=,ppid=");
    assert.include(source, "lsof -nP -t -iTCP:");
    assert.include(source, "VACUUM INTO");
    assert.include(source, "PRAGMA integrity_check");
    assert.include(source, "T3_HOME");
    assert.include(source, "APP_SUPPORT_PATH");
    assert.notMatch(source, /\b(?:pkill|pgrep|killall)\b/);
  });

  it("has recoverable app swap and API health gates", () => {
    assert.include(source, "write_state ready-to-swap");
    assert.include(source, "write_state old-moved");
    assert.include(source, "write_state new-installed");
    assert.include(source, "failed-candidate-");
    assert.include(source, "/.well-known/t3/environment");
    assert.include(source, "/api/auth/session");
    assert.include(source, "dry run complete: no files, processes, app/data");
  });
});
