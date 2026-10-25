# Prompt word index

`usage/promptWordIndex.ts` aggregates the existing T3 user-message projection.
`UsageService.readReport` calls it through `ProjectionSnapshotQuery` for prompt
reports. The existing scanner remains a compatibility fallback for test or
provider implementations without the index port. Provider token accounting is
independent. No provider history is read by the index.

Migration 055 creates `usage_prompt_words_v1`, `usage_prompt_terms_v1`, and
`usage_prompt_pending_v1` in the
existing SQLite store. They retain per-message counts, date/thread metadata and
normalized term frequencies, without another copy of raw text. These terms
are sensitive local data and inherit the database's existing access controls.
Insert/update/delete triggers maintain pending message IDs and invalidate counts
even when `updated_at` is unchanged. The migration seeds pending IDs for existing
user messages without tokenizing their text.
The authoritative message projection and event history remain untouched.

The algorithm identifier is `unicode-runs-nfkc-v1`. Rebuild its data by clearing
terms and then counts in one transaction, and enqueue every user-message ID in
`usage_prompt_pending_v1` in that transaction. The worker repopulates counts. An
algorithm change needs a separate derived schema and a rebuild, not edits to
historical prompts. Package and report contract versions are unchanged.

Reads never warm the index. `ProjectionSnapshotQuery` starts one scoped worker
when its service starts. It handles at most 32 pending IDs and 1 Mi UTF-16 units
per batch, checking a 50 ms budget between messages. It fetches one bounded
body at a time and yields for 50 ms after progress, or one second while idle or
contended. These are cooperative limits, not preemption of one SQLite statement
or one message. A message is limited to 262,144 Unicode code points.

Parsing happens outside the write transaction. Each message's counts, terms and
queue removal commit together after checking its pending generation and current
source fields. A conflicting edit cannot publish stale counts. Completed
messages survive cancellation, write contention and process restart; an
interrupted message remains queued. Startup resumes the persisted queue without
requiring a new request. Shutdown cancels the worker with the service scope.

Inside the shared connection's transaction lease, index writes temporarily use
zero busy timeout and restore the original setting on success, error or
interruption. An external writer defers the pending row instead of consuming
the persistence layer's five-second wait. Other projection operations retain
their original timeout.

The three-second request timeout now bounds only aggregation. A cold read
returns partial counts immediately, with `coverage.sourceMessages` and
`coverage.examinedMessages` showing requested-window progress. It does not wait
for a full build. The optional progress field is omitted by older producers.
Records above the text limit retain null word counts. An unindexed remainder
or null count makes coverage partial. Request timeouts cannot roll back worker
checkpoints, though failed aggregation still returns missing coverage.

Completed reads aggregate counts in SQL. Daily rows use at most 366 date range
sums against the derived date index, with IANA local-day boundaries and exact
half-open instants. The term primary key starts with `word`; keyword counts
use parameterized equality, not SQL fragments or FTS query syntax. Search
includes common words and numbers; frequency ranking retains its existing
English stopword and digit filters. Rankings no longer depend on the first
50,000 retained words.

The optional `UsageReportInput.keyword` and `UsageReportPrompts.keyword` fields
carry a single word and its occurrence/prompt totals. Web and desktop share the
existing Usage panel; mobile and Otis can continue consuming the old fields.
Otis keyword and progress support use a matched allowlist/transport change and
their own owner checks. Missing producer fields stay omitted. No authentication
or deployment changes are part of this candidate.

Back up the database through the owner's online snapshot route before applying 055. The migration changes derived tables and triggers only. Older code can
ignore these additive tables; do not remove source history or restore an older
database just to roll back code. A database restore needs separate approval and
a preserved post-cutover snapshot. The disposable backup/restart/lock probes in
`promptWordIndexRecovery.test.ts` are synthetic evidence, not a live cutover.

Coverage describes persisted T3 rows, not a complete personal archive. The
current import parser keeps at most 200 messages, preserving the first user
prompt, and does not expose import completeness to this report. It suppresses
proved Codex response/event copies during import. The index does not infer
duplicate IDs from equal text, recover omitted messages, verify authorship, or
distinguish quotations from the user's original prose. Those require source
provenance, not a tokenizer heuristic.
