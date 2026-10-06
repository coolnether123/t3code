# One overnight stopped-chat upgrade

`scripts/overnight_upgrade.py` runs through a private per-host LaunchAgent.
The calendar wakes hourly at minute 15, without RunAtLoad or KeepAlive. The
worker acts only between 2 and 4 AM America/Chicago. A failed gate records the
Central attempt date and waits until the next night. A verified completion
receipt prevents another restart and unloads the job.

Each host requires over 90 minutes of physical input idle, healthy loopback
T3 with the preserved environment identity, no pending approvals or inputs,
and no starting/running or unaccounted provider work. Pending requests count
even when their runtime is stopped. Unknown schemas and statuses fail closed.
The existing guarded deployers re-run this gate immediately before stopping.
They never dismiss requests or create chats.

The prepared configuration pins the source commit and artifact/deployer
hashes. The Desktop deployer accepts a prebuilt app through
`T3CODE_PREPARED_APP`; its normal pinned-build validation still applies.
`T3CODE_PRESTOP_GUARD` supplies the extra idle/window check. The overnight
worker supplies `T3CODE_DEPLOY_CODE_ONLY=1`: rollback retains code and a
consistent SQLite snapshot, not credentials, secrets or Electron support data.
Live data is not restored during a code rollback. Desktop uses background
LaunchServices so local saved connections remain readable without taking focus.

Only a matching running build and environment/root health 200 enable the
existing local stopped-chat marker. The private receipt is
`~/.codexdeck/t3-upgrade/receipt.json`. It distinguishes waiting, deploy intent
and verified completion. A deployment failure is not success; the next night
must reconcile the current build before attempting another stop.

The gate, artifact-proof and deployment helpers are intentional boundaries.
Keep their one-caller entry points separate: the deployers also invoke the
same gate as their final pre-stop check, and tests exercise each safety seam.
