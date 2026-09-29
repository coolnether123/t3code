# Usage report runs

`server.getUsageReport` accepts `mode: "runs"` to return usage grouped by a
provider-native session ID. The mode uses the normal usage transcript scan,
window, provider filters, global duplicate suppression, pricing, and source
coverage. It requests native-session grouping only for this mode; existing
report modes and the usage-summary contract are unchanged. The additive report
shape keeps `USAGE_REPORT_CONTRACT_VERSION` at `1`.

The scanner keeps its internal session/dedupe key separate from native run
identity. For example, an AI Studio import's content hash still supports
deduplication but is not exposed as a run ID; those records remain in the
provider's unattributed aggregate.

The durable scan cache stores native identity separately. Its v9 row format and
SQLite store schema 3 invalidate older cached records and root coverage
together. The first read after upgrading may return partial coverage while
transcripts are parsed again; an old synthetic `sessionId` is never promoted
to a native run ID.

Example request:

```json
{
  "mode": "runs",
  "sinceDay": "2026-08-01",
  "untilDay": "2026-08-31",
  "timeZone": "America/Los_Angeles",
  "providers": ["codex", "claude"],
  "runIds": ["provider-native-session-id"],
  "limit": 20
}
```

`runIds` is optional and accepts 1–32 exact IDs, each at most 512 characters.
The server filters by the parsed native session ID; it never joins on model,
timestamp, or transcript ordering. Provider filters still apply. Without
`runIds`, the response contains up to `limit` run rows (default 20, maximum
512), `totalRuns`, and `truncated`. Each row combines all models and activity
in the window and includes token partitions, API-equivalent cost, priced and
unpriced record counts, pricing coverage, and first/last activity timestamps.
Model labels are capped at 16 per run with `totalModels` and `modelsTruncated`.
The same response has `dailyRuns`, grouped by the requested local calendar day,
provider, and exact native run ID. A run crossing midnight has one window-total
row and a separate row for each day; never sum both sets. The daily rows have
their own `totalDailyRuns` and `dailyRunsTruncated`. The requested `limit`
caps each row set independently, so an exact `runIds` query with a sufficient
limit is the way to inspect one run's full daily breakdown.

Records lacking a valid native session ID are retained in `unattributed`, with
one aggregate per provider and their token and cost totals.
Daily unattributed totals are kept by day and provider in `dailyUnattributed`,
with a separate total and truncation flag. These are another view of the
unattributed window totals, not additional usage. `runCoverage`
reports the observed record, attributed-record, unattributed-record, and run
counts; its status is `partial` when any observed record is unattributed.
Filtered reads use status `filtered` and omit the unattributed aggregates
because an unknown ID cannot match an exact requested ID. The envelope's
existing `coverage` separately reports whether the source scan itself was
complete. Check both coverage fields and `truncated` before treating the result
as complete.

`threadId` is populated only for one exact, unique provider-session mapping in
T3's projected session index. Each window and daily run row reports
`threadMapping` as `matched`, `missing`, `ambiguous`, or `unavailable`; only
`matched` carries a thread ID. `threadMappingStatus` describes lookup health,
not whether every run matched. Exact T3 thread-ID filtering is not provided by
this mode: `runIds` names provider-native identities. Working-directory
labels are omitted because usage records do not retain a bounded project label.
Raw transcript paths and records are not returned.
