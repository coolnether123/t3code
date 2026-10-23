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

Mac preparation sets `VITE_OTIS_CALL_ENABLED=false`. The call control also
defaults to off when the variable is absent; a build must explicitly set it to
`true` to include the control.

Keep a database backup from before the first start of a new orchestration
version. Check retained chat records, pending requests and old-chat loading
through the installed server before accepting the release. Source checks and
an HTTP health response do not establish that history still opens.
