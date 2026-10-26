import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
NodeTest.test("build helpers work with Utility module autoloading disabled", () => {
  const file = NodePath.join(import.meta.dirname, "t3-build-common.ps1").replaceAll("'", "''");
  const result = NodeChildProcess.spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-Command",
      `$ErrorActionPreference='Stop'; $PSModuleAutoLoadingPreference='None'; Remove-Module Microsoft.PowerShell.Utility -ErrorAction SilentlyContinue; . '${file}'; $text = @{value=1} | ConvertTo-Json; if (($text | ConvertFrom-Json).value -ne 1) { throw 'JSON failed' }; if ((@(2,1 | Sort-Object) -join ',') -ne '1,2') { throw 'sort failed' }; if ((Get-FileSha256 '${file}').Length -ne 64) { throw 'hash failed' }; Write-Host '3 assertions passed'`,
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  NodeAssert.equal(result.status, 0, result.stdout + result.stderr);
  NodeAssert.match(result.stdout, /3 assertions passed/);
});
