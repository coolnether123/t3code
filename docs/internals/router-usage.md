# Retained router job usage

`apps/server/src/usage/usageQwenRouter.ts` reads terminal metadata from explicitly configured local router JSONL job logs. It does not discover paths, read settings, query the router, or change any file. UsageService composition and cross-source joins are separate work.

## Callable contract

Call `readQwenRouterUsage(source, limits?)`. `QwenRouterUsageSource` requires a stable `sourceId`, absolute `files`, and exact `additiveSources` labels. Give active and archived files from the same router store the same source ID. Independent stores need different IDs. A path or router process run ID is not a store identity.

```ts
const result = await readQwenRouterUsage({
  sourceId: configuredRouterStoreId,
  files: configuredRetainedJobFiles,
  additiveSources: ["otis", "otis-decisions"],
});
```

`parseQwenRouterLine(line, source)` exposes the same production parser without filesystem access. Its outcomes distinguish terminal jobs, ignored events, malformed rows, and terminal rows without a valid job ID.

The result contains sanitized per-job `records`, file `coverage`, parse `counters`, and `rejectedJobKeys`. It never returns prompt/completion text, descriptions, errors, backend URLs, headers, credentials, or raw rows.

## Accounting and identity

`QwenRouterJobUsage` is a reader-local contract, not a `UsageRecord`. Current native `UsageRecord` and cache contracts require a known provider and non-null token totals. Do not cast router records into them or substitute zero for null. The parent must compose the nullable measurements before publishing run or daily accounting.

Each job retains `jobId`, `requestId`, `routerRunId`, source/client labels, backend identity, model, and its terminal `timestampMs`. The reader never substitutes submission time for an absent terminal time. It prefers actual model, then backend model, then requested model. Missing model/time remains null and prevents additive attribution.

`dedupeKey` encodes the stable store ID and job ID. `sessionId` uses that key for internal grouping. Neither is a provider-native run ID. The current job logs do not emit a native Codex/OpenCode session ID or provider response ID, so `nativeSessionId` and `providerResponseId` are null. `nativeProvider` identifies an explicitly recognized Codex/OpenCode source or originator, not a reconstructed native session.

Records have these dispositions:

- `additive`: a local llama backend, an explicitly allowed non-native source, valid model/time, and no invalid recorded counters. This is attribution eligibility, not complete measured usage.
- `excludedNative`: recognized Codex/OpenCode source or originator. Retain identity for the parent's join; never add these records to native totals.
- `excludedCloud`: remote OpenAI-compatible backend. Never add passthrough traffic on top of native accounting.
- `unattributed`: ambiguous/unregistered source, conflicting native labels, unsupported backend, missing model/time, or invalid counters. Benchmark labels do not bypass source attribution.

Model-usage ledger rows and nonterminal lifecycle events are ignored. They are not a second additive source. Cross-source joins with decision records remain the parent's responsibility.

## Counter provenance

`recorded` preserves valid nonnegative safe-integer `prompt_tokens`, `completion_tokens`, and `token_count`. Absent/null counters stay null. Invalid values stay null and add an issue; the reader never rounds, clamps, or estimates them.

`measured.inputTokens` accepts `prompt_tokens` only when `prompt_tokens_source` is `usage`. The router can populate other input counts through a tokenizer or character estimate, so those values remain recorded-only.

The router's `extract_stream_metrics` can estimate `completion_tokens` from text without recording output provenance. It can also derive `token_count` from that estimate. These job fields therefore do not prove measured output or measured total tokens. `measured.outputTokens` stays null even when the recorded completion counter is present. Cache, cache-write, reasoning, and billing measurements are also unavailable and stay null. `usageStatus` is `partial` when measured input exists, otherwise `missing`.

Do not derive uncached input by treating unknown cached input as zero. Do not use prompt length, quota percentages, inferred pricing, or local execution as proof of measured counters or a zero bill. A complete file scan can still have missing usage measurements.

## Coverage and limits

Default limits are 32 distinct configured files, 32 MiB total read bytes, 64 KiB per row, 100,000 processed nonempty rows, and 10,000 retained/rejected job identities. The caller can supply positive safe-integer overrides. Files run sequentially within one shared budget; there is no unbounded directory walk or full-file read.

Only newline-terminated rows enter the parser. A final append fragment remains partial, not malformed. Oversized rows are discarded through their newline and counted once. The reader then resumes parsing later rows. Bytes include read-ahead, not just parsed rows.

File coverage reports complete, partial, missing, unavailable, or notRead. It includes snapshot size, mtime, bytes read, drift detection, and a bounded reason code. Detected appends, truncation, replacement, or read failures prevent complete coverage. These checks detect observed drift; they are not an atomic snapshot or a content hash of the whole file.

Result `status` is `missing` when every configured file is missing. It is `partial` when any file is incomplete or any malformed, invalid, oversized, or conflicting row occurs. Otherwise it is `complete`. Measurement gaps and source attribution are reported separately on the records.

Parse counters count observed row occurrences, including duplicate copies. `unknownCounters` counts absent recorded counter fields. `unknownMeasuredCounters` counts unavailable input/output measurements. `unknownSources` counts missing, ambiguous, or unregistered source attribution. `duplicateCopies` counts matching terminal metadata copies; `conflictingJobs` counts distinct rejected job identities.

The reader compares an allowlist of terminal identity, routing, model, timestamp, counter, and provenance fields. Identical copies collapse once. Conflicting copies remove the job from returned records and permanently reject its key for that read, regardless of file order. Private text differences do not affect deduplication. A partial scan may not have reached a conflicting archive copy, so its records are provisional. Do not publish it as complete history or cache it as a completed scan.

No native cache cursor or parser state is reused. Cache integration must version these semantics and preserve coverage, exclusions, rejection keys, and null measurements. A later full read can reconcile a previous partial result.

## Verification boundary

`usageQwenRouter.test.ts` exercises the production parser and reader with labeled synthetic files. It covers retained copies, conflicts, exclusions, source ambiguity, provenance gaps, malformed rows, invalid counters, missing files, and bounded reads. These tests prove local behavior, not deployed ingestion or complete live account coverage.
