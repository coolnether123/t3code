# Configure restricted maintenance

Will owns this setup. Do not execute it on Jared's PC or connect to Odysseus
while preparing the kit. The existing restricted SSH gateway implementation is
unknown. Its owner must insert the literal mappings below into that gateway;
this kit does not replace its dispatcher or SSH configuration.

## Register the broker on Odysseus

First review `scripts/odysseus/*.ps1` from the agreed Git revision. In an elevated
PowerShell session on Odysseus, Will runs this command, replacing the example
account with his actual Windows sign-in identity. Use `whoami` in his normal
session to identify that account.

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\odysseus\register-broker.ps1 -WillAccount 'ODYSSEUS\actual-owner'
```

If the restricted account has another identity, supply `-OtisAccount` too.
This creates `C:\ProgramData\OdysseusT3` and three tasks in the `\OdysseusT3`
task folder. It starts nothing. The directory must not already exist. Broker
code is writable only by administrators and SYSTEM. Will's maintenance jobs
can write only the receipts subdirectory there. The `otis` account gets read
and execute permissions, never write permission. The tasks use
`conhost.exe --headless` and limited InteractiveToken execution without stored
credentials. There are no triggers or startup registrations.

## Add the exact allowlist

Match the entire SSH command exactly and case-sensitively. No arguments,
whitespace suffix, shell metacharacters, environment expansion, or command
prefix matching are permitted. Each right-hand side is fixed administrator
configuration, not assembled from SSH input.

| Exact SSH command | Fixed local command                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3-install`      | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ProgramData\OdysseusT3\restricted-command.ps1" -Command t3-install` |
| `t3-update`       | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ProgramData\OdysseusT3\restricted-command.ps1" -Command t3-update`  |
| `t3-health`       | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ProgramData\OdysseusT3\restricted-command.ps1" -Command t3-health`  |
| `t3-status`       | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ProgramData\OdysseusT3\restricted-command.ps1" -Command t3-status`  |

Use the actual Windows directory if it differs from `C:\Windows`. A process
launcher must use `CreateNoWindow = true` and `UseShellExecute = false`, or
invoke the fixed command through `conhost.exe --headless`. Restrict the SSH key
against forwarding and interactive sessions in the existing gateway.

`t3-install` stages stable T3 and Codex for Will. `t3-update` stages a fresh
release after Will has stopped idle local agents. Neither starts or stops T3.
`t3-health` requests a fresh sanitized health receipt. `t3-status` reads existing
receipts without starting a job. A request response is not completion. Match
the receipt's action and observation time to the request, and confirm the
task's last result in Task Scheduler if no new receipt appears. A signed-out
owner or scheduler launch failure may produce no receipt. A failed receipt
does not expose private exception details; Will can run the same action
locally to see the error. Health includes HTTP readiness but deliberately
reports local agent acceptance as untested.

## Revoke or recover

Remove the gateway entries to revoke remote triggers. Will can delete the
three tasks and their folder using Task Scheduler, then remove the protected
broker directory as administrator. Keep his per-user installation and data.
Broker ACLs, task execution and the actual gateway must be verified on
Odysseus. They cannot be accepted from a local script parse or a test under
Jared's identity.

For a failed package install, `current.json` still points to the previous
validated release. Failed staging directories remain for inspection. While
the server is stopped, an operator can restore the saved `previous.json`
pointer to recover older code after checking data compatibility. Never restore
an old conversation database as a code rollback.

## Verification record and repeatable check

On October 17, 2026 at 3:18 AM CDT, the kit was tested on Jared's Windows PC
under a non-administrator token. The source base was
`a1ba32d4760e046a04eefbeb4030540c63115e46` on
`work/odysseus-kit-20261017`. The kit lives in `scripts/odysseus/`.

An actual registry install and stopped-server update installed T3 `0.1.0`,
Codex CLI `0.163.0`, and official Node `24.22.0` in a disposable directory with
spaces in its name. The update changed the release pointer and retained the
previous pointer. No credentials, existing conversations, or personal settings
were copied. The synthetic Codex home was separate from the real provider home.

The final `test-kit.ps1` run passed 20 checks covering PowerShell parsing,
rejected command suffixes and casing, reserved and occupied ports, duplicate
starts, refused running updates, unchanged active pointers on refusal, HTTP
200, explicit untested agent acceptance, the detached process's Windows SID,
loopback-only listening under the captured PID, and stopping that process.
The detached server was stopped after testing. No scheduler registration,
Jared deployment command, Tailscale mutation, desktop interaction, or Odysseus
connection was performed. No helper has only one caller.

To repeat the local test from the repository root, use a fresh disposable path
and an unused port. These commands download current stable packages:

```powershell
$testRoot = Join-Path $env:TEMP ('odysseus test ' + [guid]::NewGuid().ToString('N'))
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\odysseus\t3-user.ps1 -Action Install -Root $testRoot -Port 48784
if ($LASTEXITCODE -ne 0) { throw 'Install failed.' }
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\odysseus\test-kit.ps1 -TestRoot $testRoot -Port 48784
```

On Odysseus, acceptance still requires Will's account choice and browser
sign-in, Git availability, any administrator-approved sandbox setup, the
restricted gateway mappings, broker ACL and task execution checks, a synthetic
local agent task, and real client pairing with both Macs. Stock stable and the
Macs' installed fork revisions have not been tested together by this kit.
Jared's requirement remains access to agents on all three computers. A local
HTTP check alone does not establish that result. Start the server explicitly
after sign-in and after each laptop restart; this kit registers no autorun.
