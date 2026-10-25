# Prompt usage reports

`server.getUsageReport` accepts the additive `mode: "prompts"` with the existing
date and timezone fields, optional paired `sinceTime` and `untilTime` instants,
and a frequent-word `limit` from 1 to 512. Each read queries the projection
directly; `refresh` is accepted but has no additional effect. The default limit is 20. Windows span
at most 366 inclusive calendar days. Exact instants intersect the calendar
window and use a half-open interval. Provider, run, quota and resolution filters
are rejected. Neither existing usage contract version changes.

T3 owns this report. `UsageService.readReport` reads user messages through
`ProjectionSnapshotQuery.listPromptUsageMessages` before entering the transcript
or pricing paths. The query includes stored imported and archived messages.
It excludes non-user roles. Message IDs provide durable uniqueness inside this
database; copied messages in separate threads remain separate. This is stored
message activity, not proof of authored text or provider invocation counts.

The query uses timezone-aware UTC bounds and keyset pagination over
`created_at` and `message_id`. Migration 53 adds a partial user-message index
for that ordering. A page has at most 32 rows and 32,768 Unicode code points
per text field. The read stops at 5,000 examined messages, 4 MiB of returned
UTF-16 text characters, or its 3-second cooperative deadline. SQLite statement
execution is synchronous in the Node client, so the deadline does not promise
hard preemption of an executing statement. No transcript scan or price refresh
occurs. Text exists only during aggregation and is not persisted again.

`PromptUsageAccumulator` produces counts, daily rows and frequent words.
Words are NFKC-normalized Unicode letter/number runs. Ranking excludes common
English words, word runs containing digits, one-character terms and terms longer than
64 UTF-16 characters. Its vocabulary is capped at 50,000 entries.
`countedDistinctWords` describes only that retained vocabulary. A vocabulary
limit marks coverage partial and the ranking truncated. Oversized message text
still contributes a prompt and its original character count, but not words;
the word average becomes null. Read limits qualify all totals as subsets.

The service compares projection sequences before and after paging. A change
or unavailable sequence marks coverage partial. Repeated message IDs inside
a read are counted once and mark partial coverage. This detects mixed reads
without holding a long database transaction while the interface is active.
Punctuation splits words before ranking, so `gpt-4o` contributes `gpt`.

The prompt report has no token or pricing calculation fields. Missing
projection access returns missing coverage, not an asserted complete zero.
The Usage panel displays each environment separately and never combines
possibly copied chat histories. Web and desktop share the panel; mobile has
the typed shared query but no prompt panel yet. Local and remote clients use
the same authenticated RPC, without a baked-in host URL.

`PromptUsageAccumulator` and `PromptUsageContent` each have one production
caller. Retain them as counting/privacy and presentation boundaries; their
focused tests exercise those boundaries without loading unrelated accounting.
