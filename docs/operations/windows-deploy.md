# Windows versioned deployment

The Windows maintenance scripts prepare an exact commit in a separate release
folder. Deployment pauses both supervisor owners, copies offline userdata,
switches the durable release state, and checks all three HTTP surfaces, the new
runtime, projection reads after startup migrations, and a labelled Sol reply.
The proof thread is archived. A failed candidate restores the offline snapshot
and starts the previous release. An unfinished transaction is recovered by the
server supervisor on its next start; the web supervisor waits for that recovery.

Preparation uses the existing launcher build module. It never runs the candidate
CLI against live data. Dependency installation and build commands enter the
build queue. The service switch itself runs directly.

## First installation

Build `tools/t3-supervisor/T3CodeSupervisor.csproj` with `dotnet publish`, directing
all output outside the repository. During the coordinated idle window, stop both
existing supervisor tasks. Run `tools/t3-supervisor/install.ps1` with the built
binary, an existing project ID for the proof chat, the configured provider
instance, and the current HTTPS health URL on port 9445. Use the standard hidden
PowerShell invocation. The script backs up the installed executable and both task
XML files, initializes the previous release, and changes both task actions.
It leaves both tasks disabled. Keep the backup path for reversing the installation.

The installation config is `A:/Runtime/T3CodeReleases/deploy-config.json`. Its
supervisor script path must remain available across reboots. Start both tasks
after inspecting and enabling their actions. Then run:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts/t3-deploy.ps1 -Commit <full-sha>
```

Use `-DryRun` to inspect the resolved candidate without preparing or switching.
Use `-Status` to read the current state and last receipt. Use `-Recover` to finish
rollback of a pending transaction with both new supervisor owners running.
Do not manually clear `pending` or edit the release pointer during recovery.

Rollback restores the pre-switch userdata snapshot, including database WAL and
SHM files. Data created during the unsuccessful candidate is retained in a
separate `userdata.failed-*` directory for diagnosis. Treat those copies as
private data. Retention deletes only receipted SHA release directories outside
the last three good releases; it does not delete data snapshots or failed builds.

`state.json`, `last-deploy.json`, `last-recovery.json` and `last-idle.json` under the
release root expose the current release, checks and fallback evidence. A new
server must report complete zero-call coverage. Only a legacy snapshot with no
voice field may use zero router voice sessions with both speech tenants stopped.
An unavailable registry always blocks deployment.

## Nightly sync

Run `scripts/register-t3-nightly.ps1` once to register the limited interactive-user
task at 03:30 local. Its headless action runs deterministic source control and
verification. Registration exports task XML and leaves auto-deploy disabled.
The task's configuration and per-night JSON ledger live in the artifact folder.
Register the script as an automation output on the owning agenda task and check
the startup inventory after changing the action.

The controller requires this implementation and `docs/fork/FEATURES.md` on the
Windows fork branch before starting sync work. It selects the newest upstream
nightly by date and numeric sequence, merges in an isolated worktree, runs all
package typechecks and affected tests, and pushes a `sync/*` candidate. Failed
checks are inherited only with exact classified evidence from a cached plain-tag
baseline. Conflicts and real failures produce a bounded repair-worker packet.
Moved paths update the feature inventory during a clean merge.

After the first successful live deployment, create
`A:/Runtime/T3CodeReleases/auto-deploy-enabled` to allow the nightly controller to
fast-forward the remote Windows fork and call the same deploy entry point.
Remove it to return to candidate publication only. The controller never updates
Mac branches or rewrites remote history. A changed fork tip blocks promotion and
requires a new integration candidate.
