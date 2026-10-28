# Mac desktop and backend releases

Use `scripts/launch-t3-code-macos.sh` for an installed desktop app and
`scripts/deploy-macos-backend.ts` for a backend managed by launchd. Read their
`--help` output and pin the full source commit, source branch, backup boundary
and existing installation. The backend helper requires the inspected current
entry point through `--old-entry`.

Run the desktop launcher's dry run and `--prepare-only` before installation.
Preparation uses the locked local Vite runner after dependency installation.
Launch the actual installer detached so its lifetime does not depend on an
SSH connection. Both deployers require at least 20 GiB projected free space
and refuse active or unknown turn state. Their read-only SQLite checks cover
both legacy sessions in `state.sqlite` and current orchestration runs in the
separate `statev2.sqlite`. A missing or incomplete current run schema blocks
installation. On the first upgrade, capacity admission includes the physical
legacy database backup made by `initializeV2Database`, plus its WAL and a
metadata reserve. Migration writes require additional headroom; this estimate
is a minimum, and admission does not prove the final migration footprint.
Keep the active rollback
copy until the candidate has passed installed checks.

The desktop launcher sets `T3CODE_BACKGROUND_LAUNCH=1` with LaunchServices
`open -g`. This makes the first window reveal use `showInactive`; it restores
maximization only after the window receives focus. Later user activation works
normally. Do not replace this with an ordinary app launch during unattended
maintenance.

The rollback desktop must also support background launch. `open -g` cannot
prevent an older app from explicitly requesting focus. Before unattended
maintenance, arrange a rollback that preserves focus; an older desktop build
that calls `app.focus` requires `--headless-rollback`. That option starts the
restored bundle's server through its own Electron runtime with
`ELECTRON_RUN_AS_NODE=1`, checks its loopback listener and environment identity,
and leaves the desktop closed. It also applies if deployment fails after
stopping the old app but before swapping bundles. Startup output goes to the
null device because it can contain pairing credentials. An unsuccessful
headless health check stops its captured child and never opens the old
desktop. The installer recognizes a recovered headless backend as the owner
on later deployments. Do not assume the candidate's background flag changes
the old binary's behavior.

Mac preparation sets `VITE_OTIS_ENABLED=false` and
`VITE_OTIS_CALL_ENABLED=false`. The first removes the Otis sidebar button and
the Otis screen; the second removes the call control, which also defaults to
off when the variable is absent. Set both when building a Millie backend
candidate, because its server serves the same web client to phones.

Keep a database backup from before the first start of a new orchestration
version. Check retained chat records, pending requests and old-chat loading
through the installed server before accepting the release. Source checks and
an HTTP health response do not establish that history still opens.
