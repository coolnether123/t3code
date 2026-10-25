// @effect-diagnostics nodeBuiltinImport:off - checks shell syntax and setup-script source without running setup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

const scriptPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "setup-macos-codex-desktop-bridge.sh",
);

const source = NodeFS.readFileSync(scriptPath, "utf8");

describe("setup-macos-codex-desktop-bridge", () => {
  it("uses the package entrypoint and supports the legacy executable path", () => {
    assert.include(source, 'package_manifest="$managed_package/codex-package.json"');
    assert.include(source, 'managed_codex="$managed_package/$managed_entrypoint"');
    assert.include(source, 'legacy_managed_codex="$managed_package/codex"');
    assert.include(source, 'if [ ! -x "$managed_codex" ] && [ -x "$legacy_managed_codex" ]; then');
  });

  it("requires the daemon version check to report running before setup succeeds", () => {
    assert.include(source, '"$managed_codex" app-server daemon bootstrap $remote_control_flag');
    assert.include(source, '"$managed_codex" app-server daemon version');
    assert.include(source, '"status"[[:space:]]*:[[:space:]]*"running"');
    assert.isBelow(source.indexOf("if ! printf"), source.indexOf("The host bridge is ready."));
  });

  it("keeps the saved Remote Control choice when bootstrapping", () => {
    assert.include(source, 'daemon_settings="$codex_home/app-server-daemon/settings.json"');
    assert.include(source, 'remote_control_flag="--remote-control"');
    assert.isBelow(source.indexOf('remote_control_flag=""'), source.indexOf("daemon bootstrap"));
  });

  it("passes POSIX shell syntax validation", () => {
    if (NodeOS.type() === "Windows_NT") return;
    NodeChildProcess.execFileSync("/bin/sh", ["-n", scriptPath]);
  });
});
