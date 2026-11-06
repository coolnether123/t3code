# Christine's macOS nightly

The existing `t3-nightly-sync.mjs` controller selects its macOS route when the
private configuration has `platform: "darwin"`. It never starts a model or a
repair agent, sends a message, or requests speech. Windows behavior is unchanged.

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
host name and directory as arguments. `capture` writes only private proof files.
Unknown native pagination, status, source identity, schema or daemon versions
holds installation. Never change a network setting to make a guard pass. An
explicit wildcard listener also requires the actual userdata
`desktop-settings.json` to remain pinned as network-accessible.

## Transaction and recovery

The route requires a clean exact checkout, both Macs proven idle, and the normal
NAS source push preflight. It fetches origin and upstream, merges upstream main
without committing, installs locked dependencies, runs typecheck, `vp check`,
focused tests and `check:changed` against the pre-run source pin. Only then does
it commit. A failed owned merge is aborted. A clean owned candidate is restored
with `reset --merge` only before any installation attempt. No hard reset,
clones, additional worktrees or hook bypasses are used.

Both staged artifacts must pass. Controls copied to Millie are refreshed after
the accepted source commit. Both Macs are rechecked before each guarded install,
and the deployers recheck their own host immediately before stopping its exact
processes. Userdata backups, environment identity and managed Codex daemon
version equality remain required. Source publication to NAS is required. Origin
is attempted once; denial is recorded separately and does not authorize another
account or prevent an otherwise proven installation.

An already-current source is not proof both installations are current. Fresh
installed markers, listener ownership and health determine which Mac still needs
the accepted commit. Already-correct installations are not replayed. An
uncertain attempted deployment retains source, artifacts and recovery evidence.
A command failing after installed acceptance is reconciled from the actual
installed marker; retirement holds are separate from installation acceptance.

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
