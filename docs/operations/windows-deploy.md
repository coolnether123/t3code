# Windows versioned deployment

The Windows maintenance scripts prepare an exact commit in a separate release
folder. Deployment pauses both supervisor owners, copies offline userdata,
switches the durable release state, and checks all three HTTP surfaces, the new
runtime, projection reads after startup migrations, and a labelled Sol reply.
The proof thread is archived. A failed candidate restores the offline snapshot
and starts the previous release. An unfinished transaction is recovered by the
server supervisor on its next start. Recovery failure is recorded in
`last-recovery.json`; both owners then start `state.current` without clearing the
pending journal. The web owner waits up to ten minutes for the recovery result.
A pending journal does not suppress restarting an unpaused crashed child. Explicit
stop commands still pause owners for offline snapshots. `-Status` exposes
`stuckPending` and the recovery receipt so fallback is visible.

The supervisor pipe uses Node's `readableAll` and `writableAll` listen options to
permit clients from other Windows sessions. Node has no per-SID DACL option.
This grants local users pipe access, including stop/start commands. Keep this
choice limited to this maintainer workstation. Connection errors name the pipe
and distinguish access denial, EPERM, from an absent owner, ENOENT.

## Re-pin installed controls

From a clean committed candidate, run:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File A:/Dev/Worktrees/t3-auto-sync-20261025/scripts/t3-repin-control.ps1
```

Add `-DryRun` to check idle state and prerequisites without backups or restarts.
Keep auto-deploy disabled and resolve any pending transaction first. The script
holds the deployment lock, checks idle state, backs up config and both task XMLs,
pins controls with hashes, stops both existing tasks and requires ports to close.
The installed wrapper's kill-on-close job owns the child processes. It atomically
replaces config and restarts both tasks. Ports 3774 and 6803 have 330 seconds to
return, followed by HTTP and owner identity checks. Failure restores the old
config and restarts both tasks, with another full startup wait. No task XML or
principal is changed. Backups remain under the configured artifact root.

Run this only in the parent's idle window. The synthetic fixture proves restore
behavior; it does not prove the live scheduled-task or cross-session path.

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

The installation config is `A:/Runtime/T3CodeReleases/deploy-config.json`. The
installer pins control scripts under the release root, with source and file
hash receipts. Start both tasks
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
the last three good releases. After a newer verified good deployment, snapshot
retention removes older successful snapshots outside those releases. Failed,
pending and unrecognized snapshots remain available for recovery. Failed builds
are retained.

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
Registration requires a clean source candidate and pins the control scripts in
that folder. Use `-Repository` to select the persistent Windows checkout and
`-Update` to back up and replace this task's existing action.
Register the script as an automation output on the owning agenda task and check
the startup inventory after changing the action.

The controller requires this implementation and `docs/fork/FEATURES.md` on the
Windows fork branch before starting sync work. It selects the newest upstream
nightly by date and numeric sequence, merges in an isolated worktree, runs all
package typechecks and affected tests, and pushes a `sync/*` candidate. Failed
checks are inherited only with exact classified evidence from a cached plain-tag
baseline. Each run explicitly fetches the current remote fork tip before
choosing its merge base. Conflicts and real failures write `repair.md` and
`NEEDS-PARENT.json` in the night folder and append a `needs-parent` ledger result.
The manifest records night, branch, worktree, packet path and conflict count.
The parent launches the packet in the morning. The scheduler never calls
`start_agent` or invents a chat identity.
Moved paths update the feature inventory during a clean merge.
Unavailable verification is recorded without starting a repair worker. Re-running
the same night preserves an existing candidate for resumption.

After the first successful live deployment, create
`A:/Runtime/T3CodeReleases/auto-deploy-enabled` to allow the nightly controller to
fast-forward the remote Windows fork and call the same deploy entry point.
Remove it to return to candidate publication only. The controller never updates
Mac branches or rewrites remote history. A changed fork tip blocks promotion and
requires a new integration candidate.
