# Retain tool output and compact the database

T3 stores opaque `data` from `tool.updated` and `tool.completed` activities with
lossless DEFLATE when the JSON exceeds 16 KiB and compression saves space.
Events and activity projections use the same versioned codec. Persistence
readers restore the original data before replay, paging and worker delivery.
Checksums reject corrupted data. SQL-visible lifecycle metadata stays unchanged.
Messages, plans, approvals, input decisions, command receipts and provider
resumption state are not pruned. There is no age-based deletion policy.

## Admit maintenance

Both macOS deploy routes require forced APFS clones, with no full-copy fallback.
Each allocating operation reserves its projected cost above 20 GiB free.
Checkpoint the WAL only after the owned writer has stopped under the existing
idle and pending-request gates. A failed checkpoint blocks the clone.
After a successful install and rollback validation, retire only the previous
rollback identified by the route's ownership receipt. Unmarked backups remain.

Compaction requires no active agent, a GUI login, ten minutes of physical idle,
preserved pending-request fingerprints and a held admission gate. Close all
database writers and verify the WAL checkpoint. Keep a forced APFS clone in
`~/OtisPrivate/rel-20261013/t3-db/` before changing any payload.

Clone a separate candidate. Run `scripts/retain-tool-payloads.ts --execute`
with the candidate and a fresh sibling output. The tool refuses live paths,
existing output files and non-quiescent candidates. It reserves three database
sizes for candidate divergence, journal and output, in addition to the 20 GiB
floor. It updates only opaque tool data, checks every logical payload, then
uses `VACUUM INTO` and validates and fsyncs the output. It never performs cutover.

Before the owner replaces the live database, compare all table counts,
event sequence and stream versions, command receipts, message content hashes,
pending requests, provider mappings and environment identity with the coherent
rollback. A controlled restart must pass health, old-thread paging and provider
resume readback without starting a turn. Unknown activity blocks cutover.

## Revert

Before admissions resume, stop the exact new writer and restore the coherent
rollback database set with its matching previous application. Keep the failed
candidate privately. Never mix an older main file with newer WAL sidecars.
After new work has occurred, never overwrite it with the pre-install database.
Instead, clone the current quiescent database and run the tool with `--restore`
to expand encoded tool data before returning to an application without the codec.
Validate the candidate and preserve newer work before any cutover.

The codec and maintenance capacity functions are intentional persistence and
operation-admission boundaries. Retain them rather than inline them.
