# Christine's macOS nightly

The existing `t3-nightly-sync.mjs` controller selects its macOS route when the
private configuration has `platform: "darwin"`. A verified merge conflict permits
one `gpt-6.1-sol` high resolver per upstream head. It never sends a message or
requests speech. Windows behavior is unchanged.

Run the installer on Elora after review. Without `--execute` it only reports the
label, plist and first run. With `--execute` it installs
`com.christinesmith.t3-nightly-sync` for 03:30 in Elora's verified system timezone,
`America/New_York`. It does not run immediately. It refuses another T3 nightly or
upgrade plist, including the obsolete `com.christine.t3-latest-idle-20261104` job.
Retire that exact old job separately after verifying it is not running, keeping
its plist recoverably. Do not remove its runtime or data.

```sh
node scripts/register-t3-nightly-macos.mjs /absolute/private/nightly.json
node scripts/register-t3-nightly-macos.mjs /absolute/private/nightly.json --execute
```

The scheduled entry points at the canonical checkout, never a task worktree. Its
Python wrapper takes an OS-owned advisory lock and replaces itself with Node,
keeping that lock through exec. A crash releases the lock automatically. To run
the controller manually without installing the schedule, use the same wrapper:

```sh
/usr/bin/python3 scripts/t3-nightly-macos-lock.py /absolute/private/nightly.json
```

Add `--preview` for active-work admission only. It verifies the clean source,
host identities, native daemon versions and each host's checkpoint snapshot,
then writes the admission counts to the private `result.json`. It does not fetch,
merge, build, publish, checkpoint the running backend, restart, resume work or
write task history. Transferred controls, configuration and proof files stay in
the run's private directories. `maintenanceMode: "prepare-only"` is different:
it builds and publishes a candidate without installing it.

## Private configuration

Keep the config outside Git as an owner-only regular file, mode 0600. Confirm
hostnames, identities, executable paths, existing source paths, listener addresses
and environment IDs from the actual running installations. This shape contains
placeholders, not installation evidence:

```json
{
  "platform": "darwin",
  "repository": "/Users/christinesmith/Developer/t3code",
  "branch": "christine/t3-3669-mac-20261028",
  "artifactRoot": "/Users/christinesmith/.local/share/t3-nightly/runs",
  "node": "/Users/christinesmith/.local/lib/node-v24.18.0/bin/node",
  "stagingNode": "/Users/christinesmith/.local/lib/node-v24.18.0/bin/node",
  "vp": "/Users/christinesmith/.vite-plus/bin/vp",
  "stopRoot": "/Users/christinesmith/Codex_Workroom/task_evidence/otis-control",
  "focusedTests": [
    "scripts/deploy-macos-backend.test.ts",
    "scripts/launch-t3-code-macos.test.ts",
    "scripts/stage-macos-backend.test.ts"
  ],
  "elora": {
    "home": "/Users/christinesmith",
    "hostname": "VERIFY",
    "environmentId": "VERIFY",
    "sourceRoot": "/Users/christinesmith/Developer/t3code",
    "baseDir": "/Users/christinesmith/.t3",
    "node": "/Users/christinesmith/.local/lib/node-v24.18.0/bin/node",
    "nativeSocket": "/Users/christinesmith/.codex/app-server-control/app-server-control.sock",
    "backupRoot": "/Users/christinesmith/.local/share/t3-nightly/rollback",
    "listenerAddresses": ["*:3773"]
  },
  "millie": {
    "ssh": "millie-codex",
    "home": "/Users/millie",
    "hostname": "VERIFY",
    "environmentId": "VERIFY",
    "sourceRoot": "/Users/millie/OtisPrivate/t3-release-source-20261022",
    "baseDir": "/Users/millie/.t3",
    "node": "/Users/millie/.local/lib/node-v24.18.0/bin/node",
    "nativeSocket": "/Users/millie/.codex/app-server-control/app-server-control.sock",
    "backupRoot": "/Users/millie/.local/share/t3-nightly/rollback",
    "listenerAddresses": ["127.0.0.1:3773"]
  }
}
```

Include the current parent-wake, model-policy and changed-feature Vitest tests in
`focusedTests`. They are paths only, not arbitrary commands. The controller also
runs its fixed Node fixtures and Python guard tests. The supported backend stage
requires the verified Node 24.18.0 runtime on matching arm64 Macs.

For a read-only host rehearsal, create a private empty directory outside Git and
run the host helper's `capture`, then `installed` operations with the config,
host name and directory as arguments. `capture` writes only private proof files
and returns counts of active runs, pending approvals, child agents and held work.
Active work does not require idle admission. Unknown native pagination, source
identity, schema or daemon versions still holds installation. Never change a
network setting to make a guard pass. An
explicit wildcard listener also requires the actual userdata
`desktop-settings.json` to remain pinned as network-accessible.

Native proof scans every active and archived page, including child sources. Its
bounded read budgets are 30 seconds per RPC and 600 seconds for the full scan,
with a 610-second outer helper limit. A nonzero exit or outer timeout saves a
private `native-proof-*.stderr.log` beside the run's baseline. Missing or failed
proof still holds installation; a timeout never means idle.

## Transaction and recovery

The route requires a clean exact checkout, both Macs' active-work admission, and the normal
NAS source push preflight. It fetches origin and upstream, merges upstream main
without committing, installs locked dependencies, runs typecheck, `vp check`,
focused tests and `check:changed` against the pre-run source pin. Only then does
it commit. A failed owned merge is aborted. A clean owned candidate is restored
with `reset --merge` only before any installation attempt. No hard reset,
clones, additional worktrees or hook bypasses are used.

For real conflicts in its own merge, the controller reserves
`artifactRoot/resolver-heads/<upstream-sha>.json` durably before launching the
resolver. This is enabled without a configuration switch. It verifies Christine's
logged-in `gui/<uid>` domain, then runs her exact `~/.local/bin/codex` through
`launchctl asuser`. No GUI window opens or takes focus. Missing GUI, authentication,
model availability or launch failure holds the run. There is no alternate model,
account or route, and no second attempt for that upstream head, even after a crash.
Do not remove a reservation to retry an unchanged head.

The resolver uses `gpt-6.1-sol` with high effort, no user configuration, an ephemeral
session, noninteractive workspace-write protection and no shell network access.
It edits tracked source to resolve the merge and integration problems while
preserving parent wake, Sol-medium defaults without costly fallback, Mac features
and the existing nightly/deployment guards. It may run relevant focused checks.
It must not stage, commit, publish, install, change branches, touch live chats or
userdata, send Deck updates, spawn agents, or control apps/processes. The controller
stages its edits, verifies the original base and merge identity, and runs every
normal gate before committing or calling the unchanged guarded install steps.
The install path remains callable through the normal locked controller for the
combined maintenance window; the resolver never installs directly.

The resolver's prompt, stdout, stderr, final response and result stay in the run
folder. A one-hour limit cancels only its owned process group. If that group's
exit is uncertain, the merge is retained for recovery and no install or automatic
abort occurs. Partial or running reservation records also hold source recovery.
One quiet text-only note uses the existing Deck history route when the run ends;
history delivery failure is recorded without retry or speech.

Both staged artifacts must pass. Controls copied to Millie are refreshed after
the accepted source commit. Both Macs are rechecked before each guarded install,
and the deployers recheck their own host immediately before stopping its exact
processes. The active checkpoint guard records source run identities and fences
uncertain work before the stop. Eligible continuation identities are durable and
reused after a crash; the updater never resubmits the original prompt or replays
confirmed tool writes or sends. Work that cannot be resumed safely receives a
held note, including approval state that cannot be carried forward live.
Userdata backups, environment identity and managed Codex daemon
version equality remain required. Source publication to NAS is required. Origin
is attempted once; denial is recorded separately and does not authorize another
account or prevent an otherwise proven installation.

An already-current source is not proof both installations are current. Fresh
installed markers, listener ownership and health determine which Mac still needs
the accepted commit. Already-correct installations are not replayed. An
uncertain attempted deployment retains source, artifacts and recovery evidence.
A command failing after installed acceptance is reconciled from the actual
installed marker; retirement holds are separate from installation acceptance.
The controller durably records each host as `attempting` before invoking its
deployer, then as `accepted` only after the installed source and checkpoint
recovery both verify. A source marker alone cannot accept a swap. The pre-stop
manifest remains separately pinned while a fresh capture records the new
listener. Missing or duplicate continuation proof retains the run for recovery.

An archive peer may win Millie's cold-backup gap before the installed service
starts. The controller permits one bounded handoff only after proving the new
installed service, this attempt's intact cold backups, the exact new peer PID
and its SSH ownership records. It briefly pauses only Elora's exact idle desktop
main, not its backend or renderers. A separate identity-pinned watchdog resumes
that same main after the remote action lease expires, no later than 75 seconds.
The hosts' clocks and SSH latency must pass a bounded check first. The candidate is never
reinstalled. Changed identities, in-flight peer startup, active or unknown work,
missing backup evidence, or failed ownership proof hold the run for recovery.

One active rollback is retained. Superseded receipt-owned originals are first
APFS-cloned to the owner's private local `rollback-archive`, with a complete
byte inventory, then retired from the active backup root. They are not exported
to the NAS or permanently discarded. Archive failure retains the originals and
a recovery receipt. Archived originals still consume disk space. Only generated
build leftovers owned by that run are deleted, and uncertain installation
artifacts stay for recovery.

Each failed run appends one plain text-only note to the existing Deck task. If
that local history service is unavailable, the run's private result records the
failed history delivery without retrying or sending elsewhere. Background steps
honor only `STOP-ALL` and `STOP-t3-nightly-sync` in the configured shared controls
directory. The full command log and result remain private.
