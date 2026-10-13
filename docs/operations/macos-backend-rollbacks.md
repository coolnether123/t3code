# Keep a Mac backend rollback without a full data copy

Use one stable `--backup-root` for successive backend installs. The guarded deployer requires at least 20 GiB free before preparation and immediately before stopping. It retains pending requests only when `T3CODE_PRESERVE_PENDING_REQUESTS=1` and an exact fingerprint guard is supplied.

The deployer validates the isolated candidate, captures the old launcher, and rechecks idle admission. It then stops the captured backend and unloads its launch agent. With no backend writer, it checkpoints SQLite's WAL and force-clones the database on the same filesystem. Unsupported cloning fails rather than silently copying the database. Configuration backups also use forced cloning. The live database is never restored during code rollback.

The new backend starts before the clone's full integrity check, reducing the outage. Verification opens the checkpointed clone as immutable, without creating WAL sidecars. Acceptance requires health and clone integrity. Only after successful acceptance does the deployer retire the previous rollback named by its own marker. It never sweeps other rollback roots. The current clone, previous launcher and previous backend remain available.

After a failed activation and code rollback, `T3CODE_REUSE_VERIFIED_INSTALL=1` permits reusing the existing immutable code directory only when its complete contents match the verified candidate. It never replaces that directory. A fresh idle admission and point-in-time rollback still apply. This flag does not permit repeating an accepted install or resending approval replies.

For a code revert, first pass the same idle and pending-request gates. Unload the owned backend launch agent, restore `previous-launch-agent.plist` and `previous-t3-wrapper` from the current rollback directory, then bootstrap the restored plist. Verify the prior source hash and health. Keep the additive database migrations and newer saved replies.

SQLite's WAL must be included in a live backup or safely checkpointed with writers stopped. See [SQLite WAL format](https://sqlite.org/walformat.html). Apple documents clone blocks as shared until either file changes; see [clonefile](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/clonefile.2). Unlike a forced clone, [cp -c can fall back to a full copy](https://github.com/apple-oss-distributions/file_cmds/blob/main/cp/cp.1).
