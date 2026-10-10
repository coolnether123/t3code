# Otis prompt analytics subscriber

T3 owns messages and the Usage UI. Otis owns prompt counts, words, terms and
keyword reports in an independently packaged component and store. Provider
token accounting, pricing and quota are unchanged.

The server reads `POST /api/v1/usage-analytics/report` through loopback HTTP
with the existing local read token. The token remains server-side. Web,
desktop and remote clients use the existing typed usage WebSocket RPC. No
browser origin or network configuration changes are needed. Mobile shares
the additive contract but currently has no prompt panel.

## Configuration and selection

Configure through the existing owner launcher. Never put credentials in source,
public notes or parity receipts.

| Setting                        | Meaning                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `T3_OTIS_USAGE_ORIGIN`         | Loopback HTTP Otis origin, without paths or URL credentials |
| `T3_OTIS_USAGE_TOKEN`          | Existing local read token, not a newly issued credential    |
| `T3_OTIS_USAGE_SOURCE_ID`      | Stable source identity, defaults to `t3-local`              |
| `T3_OTIS_USAGE_MODE`           | Default dual-read; `off` rollback; `otis` admitted cutover  |
| `T3_OTIS_USAGE_PARITY_RECEIPT` | Local passing v1 parity receipt required for `otis`         |

Unconfigured T3 retains existing behavior. Dual mode reads both authorities
and selects Otis only for complete, current, equal reports. Comparison checks
totals, ordered rankings, daily rows, keywords, vocabulary, truncation and
coverage. Diagnostics contain only differing field names. A mismatch keeps
T3 selected. Missing service, partial index and stale data select the local
fallback and label the reason. Refresh retries the service and reconnects.

The v1 consumer rejects unknown majors or policies, wrong source or window,
unsupported filters and oversized responses. It accepts and ignores additive
fields. Existing producers may omit optional `analytics` metadata. Older
consumers may ignore that metadata without losing existing required fields.
`promptSource: "t3"` forces the retained producer for compatibility checks.

After the parent admits `otis` mode with a passing receipt, reads skip local
recomputation. The existing index worker pauses, retaining its tables, pending
queue and migration-055 triggers. A fallback request resumes it for 60 seconds.
Cold fallback reads stay explicitly partial while it catches up. Restart
retains pending IDs. Without a valid receipt the worker continues and requests
remain dual-read. No migration or table removal is part of this switch.

The receipt must have `schemaVersion: 1`, `reportContractVersion: 1`, policy
`unicode-runs-nfkc-v1`, `matched: true`, `sourceDrift: false`, and at least one
window, all matched. Otis's `scripts/parity.mjs` produces this format. The
receipt admits compatibility, not live deployment or UI acceptance.

## Release order and rollback

1. Preserve the prior Otis package and consistent backups of its store and
   refresh directory. Package and store schema 1 remain compatible.
2. Release the host adapter and component through their owner routes. Configure
   one refresh owner with the read-only source. Verify completion and freshness
   through authenticated reports before selecting a consumer.
3. Release the gateway subscriber in dual mode. Compare exact reports on fixed
   read-only snapshots and observe live mismatches without changing counts.
4. Release T3 in dual mode after owner checks. The parent owns T3's idle check
   and consistent database backup. Preserve migration-055 data and code.
5. After parity and live acceptance, the parent may select `otis` mode with the
   passing receipt, then verify the prompt panel and keyword search.

For T3 rollback, select `off` or remove the origin through the owner route.
The original report and worker resume from the retained queue. An older T3
package also reads the unchanged additive schema. Keep the trusted backup;
do not restore an old database over newer messages.

For Otis rollback, select the previous immutable component and compatible store
with retained refresh snapshots. Stop only the admitted owner through the host
release route. Never run two mutation versions against the store. T3 falls
back independently, so analytics rollback cannot remove messages. A future
incompatible schema needs a separate store, not an in-place overwrite.
This documentation does not authorize a worker to cut over or restart live code.
