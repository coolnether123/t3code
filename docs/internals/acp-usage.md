# ACP usage capture

Cursor and Grok retain optional ACP usage metadata through the existing native
provider log. Capture does not update `UsageService`, the usage cache, turn
accounting, or client projections. Other provider adapters are unchanged.

## Counter semantics

The generated `effect-acp` schema is the current protocol authority. Its
`PromptResponse.usage` description says "Token usage for this turn", but
`Usage.inputTokens` and `Usage.outputTokens` say "across all turns" and
`Usage.totalTokens` says "across session". That contradiction prevents request
attribution for either provider under this contract.

`readAcpPromptUsage(response)` retains the six declared counters in
`reportedTokens`. When counters are present, it sets `tokenBasis` to `ambiguous`
and `scopeConflict` to `true`. Every `requestTokens` field remains `null`.
It never subtracts observations, including increasing or decreasing values.

An independently established per-request contract can use
`readAcpPromptUsage(response, "request")`. This copies validated counters into
`requestTokens`. Neither adapter selects that basis today. A synthetic test of
this option is not evidence that Cursor or Grok emits per-request usage.

All token fields accept nonnegative safe integers. Missing, null, or invalid
values remain `null`; `invalidFields` names invalid declared fields without
retaining their contents. Zero is a measured value. Cache inclusion in input,
thought inclusion in output, and the composition of `totalTokens` are not
established here. Do not calculate uncached tokens, add cache or thought counts
to totals, or price these observations as normalized request usage.

`usage_update` has different semantics. `used` is current context occupancy,
`size` is context capacity, and `cost` is cumulative session cost in its stated
currency. Capture retains these as `contextUsedTokens`, `contextSizeTokens`,
and `sessionCost`, with null request and turn identities. It does not convert
them into request tokens, request cost, USD, or cost deltas. Foreign-session
and replay notifications are excluded.

Neither provider has an established model identifier, per-request cost,
cache-composition rule, reasoning-composition rule, or provider billing request
ID in these usage messages. Arbitrary `_meta` fields are unsupported. No prompt,
answer, credential, or raw ACP payload is copied into usage metadata.

## Receipt identity and limits

Each dispatched adapter prompt gets a fresh UUID sent as ACP `messageId`.
The receipt uses the captured native session, actual T3 turn, and that request
UUID, even when completion arrives after cancellation or the active turn
changes. Steering prompts may share a turn, but not a request identity.
The response may echo the UUID as `userMessageId`.
An echoed ID never replaces the dispatched ID. A mismatched echo sets
`acknowledgementMismatch`; its raw value is not retained.

The native event `id` is the JSON-encoded tuple
`[provider, nativeSessionId, turnId, requestId]`. Deduplicate by this tuple
across copied logs, repeated imports, and reader retries. A new dispatch is a
new request, not a duplicate of an earlier dispatch.

Each session capture remembers the latest observation for 256 request
identities and one session snapshot. Identical recent request receipts and
consecutive identical session snapshots produce no extra writes. Changed
request receipts reuse the event ID, set `receiptConflict`, and retain the
previous declared counters in `previousReportedTokens`. Consumers must keep
that conflict explicit, not sum or silently select conflicting counters.
After eviction or a process restart, reader-side identity comparison is still
required. The memory window is not a persistent dedupe database.

If a prompt returns `cancelled`, supplied counters are retained with that
outcome. Failure or fiber interruption before a response produces an
unavailable receipt with null counters. Capture does not infer the missing
response or bill a partial text stream. Usage updates received before the
handler is installed after session startup are not recovered.

Grok's existing private prompt-completion fallback can win its race with the
ACP RPC response and return a response without usage. Capture records it as
unavailable; it does not recover counters from the losing RPC or parse private
`agentResult` payloads.

Identifiers are limited to 512 characters. Parsing reads only declared data
properties, never enumerates arbitrary payload keys or invokes accessors, and
validates projected values with compiled Effect schemas. Log buffering,
rotation, and retention remain owned by `EventNdjsonLogger`. Capture is optional
when no native logger is configured. Logging is best-effort, not an account
history or guaranteed billing ledger.

## Parent integration contract

`apps/server/src/provider/acp/AcpUsage.ts` exports:

- `AcpUsageMetadata`, the version-1 Effect schema for prompt receipts and
  session observations, plus its inferred TypeScript type.
- `AcpTokenCounters`, the nullable six-counter schema.
- `readAcpPromptUsage(response, basis?)` and `readAcpSessionUsage(update)`, the
  bounded normalizers described above.
- `makeAcpUsageCapture({ provider, threadId, nativeSessionId, nativeEventLogger })`,
  an Effect requiring `Crypto`. It returns `capturePrompt`,
  `capturePromptExit(turnId, requestId)`, and `captureSessionUpdate`.

Both adapter drivers already supply the native logger. They register the
session-update handler after startup and attach `capturePromptExit` to the
prompt effect before turn settlement. No shared event contract change is
needed to retain these observations.

Read existing thread-scoped native logs, including retained rotations. Despite
the logger's name, disk lines use `[timestamp] NTIVE: <JSON>`, not bare NDJSON.
For base path `provider.ndjson`, a thread's file is `provider.<thread>.log`.
The JSON envelope has `observedAt` and `event`, with `event.kind === "usage"`,
`event.provider`, `event.threadId`, `event.id`, `event.createdAt`, `event.method`,
and `event.payload`. Decode `event.payload` with
`Schema.decodeUnknownEffect(AcpUsageMetadata)`. Dispatch on `payload.source`.
Use envelope time as capture time, not an invented provider response timestamp.

The parent must still add source discovery and conflict-aware reader dedupe,
decide nullable accounting and provider admission, and reconcile reporting.
`UsageProviderKind` currently omits Cursor. Current normalized usage requires
numeric counters and established cache/reasoning composition, which these
observations cannot supply. Keep unavailable values null rather than adapting
them to zero just to satisfy that schema.

If orchestration later needs these observations in its runtime stream, the
smallest proposed addition is one typed `request.usage.observed` event carrying
this metadata and its stable receipt identity. Keep session observations
unattributed. `turn.completed.usage` is already untyped, but does not by itself
represent multiple dispatched prompts, pre-completion interruptions, and
session-only updates. This event proposal is not implemented here.

Shared coverage and live acceptance remain parent work. Retained metadata alone
does not prove ingestion, deployment, provider support, or complete history.
