# Prepare the daily-use local build

The Windows deployment launcher supports an existing service owner:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts/launch-t3-code.ps1 -DryRun -Full -PrepareOnly
```

`-PrepareOnly` keeps the launcher's source synchronization, exclusions,
locked dependency installation, package checks, and web, server, and desktop
bundles. It does not stop or start processes or change Tailscale Serve.
Without `-PrepareOnly`, the launcher retains its Electron-owned hosting mode.

`-SkipTypecheck` is an explicit recovery valve for a dirty integration branch
with already-recorded typecheck failures outside the deployment change. It runs
all web, server, and desktop builds but records `build-without-typecheck` in the
deployment manifest. Run and retain the affected tests and focused lint before
using it. The default path still requires every package typecheck.

Before removing `-DryRun`, back up the deployment's actual files, service
configuration, and database. A live database needs a consistent SQLite backup,
not a plain file copy. Check all pages of `t3 agent snapshot` for active turns
and pending requests. Preparation changes served files even though it keeps
processes running.

After preparation, restart the verified service owner during an idle window.
Keep its existing T3 home, environment identity, authentication, and remote
origins. Recheck the deployed runtime with `t3 agent`, then verify client
rendering locally and through the existing Tailscale URL.

Every non-dry run writes `t3-deployment-<timestamp>.json` under the T3 home's
`userdata/verification` directory. The manifest records the source branch and
commit, a hash and file list for the exact dirty source projection, the detached
deploy commit, hashes for the server, web, and desktop entry artifacts, the
toolchain, endpoints, and protected exclusions. Use this manifest with the
preparation backup to identify the exact rollback candidate. Restore code and
artifacts only. Do not replace the live conversation database during a code
rollback.

`prepared` is not a readiness claim. If a check or build fails, do not restart
into that partial build. Restore the backed-up code before continuing. Code
rollback must not replace the live conversation database with an older copy.

## Identify the running fork before updating

The upstream nightly installer is not the custom local fork. Keep the current
package version unless an exact replacement version has been authorized.
Read the environment descriptor at `/.well-known/t3/environment`, then compare
the deployment manifest's artifact hashes with the actual deployment files.
The mirror's detached Git HEAD alone does not identify its copied source.
A `preparedOnly` manifest proves preparation, not that a process loaded that
build. Correlate its timestamp and hashes with the runtime record, supervisor
start log, and served client. Record unavailable process command lines as
unknown rather than guessing their arguments.

If the running artifacts already match the accepted commit, no source upgrade
is required. Check that fact before scheduling an interruption.

## Preserve the service owner's rollback

Read the current scheduled-task actions before selecting a restart route.
When separate native supervisors own the backend and hot web client, use
`-PrepareOnly` for the launcher. Do not use its default Electron-hosting path
or start a second server against the same T3 home.

Before preparation, preserve the mirror's actual source overlay and every
file in its built server, web, and desktop output directories. Keep dependency
links, deployment-only files, protected exclusions, authentication, and the
detached Git identity intact. Do not reset the mirror to its old Git HEAD or
use a deleting synchronizer. Recheck file hashes after making the code backup.

Use SQLite's online backup API or `VACUUM INTO` with a read-only source
connection for a live database snapshot. Run `PRAGMA integrity_check` and
`PRAGMA foreign_key_check` on the copy, and record key table counts and the
latest migration. Never test restoration or migration against the live home.
Use disposable synthetic databases for recovery rehearsals.

Immediately before any served-file change or restart, page through
`t3 agent snapshot --base-dir <live-home> --offset <offset>` until
`listPage.nextOffset` is null. Inspect running turns, starting sessions, active
turn IDs, and pending approval or user-input flags. If `shellSequence` changes
between pages, repeat the check. A previous idle observation is not a lock;
coordinate an idle window with the clients before stopping either supervisor.

For a code rollback, stop the verified service owners, restore the exact saved
code and build outputs, then restart those same owners. Leave the conversation
database and its WAL files in place. A database restore is a separate data
cutover: it can discard every conversation change after the backup. Preserve
the post-release database and obtain the required restore authorization before
replacing it. Do not describe a tested backup as a tested live restore.
