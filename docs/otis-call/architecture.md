# Otis Call: architecture and unfinished implementation

Task: `agenda-task:515bbc54cb61482681e950e524421ce4`.
Source baseline: `a1ba32d476`, branch `work/otis-call-20261018`.
Inspection date: 18 October 2026, America/Chicago (CDT).

This is a transfer of design knowledge, not an acceptance report. The working tree
contains a partial implementation. It has not passed a typecheck, run a call, or
been deployed. Jared stopped feature work to move the remaining build to
**GPT-6.1-Sol, high reasoning**. No worker was launched by this chat.

## Intent and decisions

The task's revision 5 links a newer correction packet, read during this handoff:
`A:/Dev/Artifacts/agent-packets/otis-call-20261018/jared-corrections-20261018.md`,
from Jared's chat `85d35823` on 18 October. It supersedes the proposed extra voice
restrictions: **confirmation defaults off; hanging up leaves the chat working;
voice uses T3's normal model selector; speech is natural language, never raw JSON**.
Whether to retain extra confirmation as an option belongs to the parent. This
document carries those requirements forward without implementing them. The current
code still defaults confirmation on, interrupts on close, and restricts calls to
Claude. Those are known mismatches, not accepted design decisions.

Jared wants an ordinary T3 agent chat he can talk to from his phone. His speech
belongs in that chat; the answer should stream there and be spoken. Waiting for
thinking is acceptable. A spinner that conceals an unavailable engine is not.

The original architecture was read from
`A:/Dev/Artifacts/agent-packets/otis-call-20261018/architecture.html`, the export
of <https://claude.ai/artifact/TQZMmnQdkbMwzB4MiExSNF>. It is a plan. Its older
standalone gateway, CPU recognizer, Kokoro-first, and future conductor suggestions
are not requirements to duplicate those systems. The later T3 integration request
and the parent's direction to extend `/api/voice` govern this implementation.

Decisions to preserve:

- Reuse T3 authentication, chat commands, provider sessions, projections, and
  streaming messages. Do not create a separate conversational backend or a second
  Otis chat in `otis-voice`.
- Keep raw incoming audio and transcripts on the PC before downstream use.
  The old no-retention voice contract is superseded. The phone needs a durable
  outbox while the PC is unreachable; it must not transcribe through a cloud
  fallback or send an unsaved transcript to Claude.
- Obtain local speech capacity through the existing router lease API. The parent
  now confirms Breeze TTS 2 and Whisper large-v3-turbo are installed as speech
  tenants. No downloads are required for these engines. Installation is parent
  evidence; this sandbox has not observed their runtime health.
- Use T3's normal selected model/provider; Haiku 5.5 on `claudeAgent` is the first
  requested acceptance target. Keep the model visible and reject unavailable choices.
  Medium is Jared's requested starting point, not a measured latency recommendation.
- Use ordinary harness permissions by default. If the parent retains optional
  voice confirmation, enforce it at tool execution and bind each answer to one
  invocation and its arguments. Do not introduce a separate voice worker authority policy.
- Keep storage, provider orchestration, speech transport, and client audio separate.
  Reuse ordinary chat history for tool results. An agent-viewer panel, post-call
  linker, Gmail, and product receipts are outside phase 1.

Rejected alternatives: the September gateway has no demonstrated working call
and no required retention; importing it adds another protocol and auth boundary.
Pipecat or new speech engines are unnecessary before the existing path works.
Sending transcripts through the composer's callback loses server-controlled
ordering and durable delivery identity. Browser-only storage does not satisfy
PC-first processing. Prompt-only confirmation is bypassable. A semantic gate on
the GPU-resident 27B conflicts with the call's GPU profile.

## Components and call lifecycle

| Component | Responsibility and boundary |
| --- | --- |
| `packages/contracts/src/speech.ts` | Wire requests, call options, acknowledgments and snapshots. Existing speech transport requests remain a separate union member. |
| `packages/client-runtime/src/voice-call/session.ts` | Client lifecycle, outbox replay, sentence queue, playback acknowledgment, and interruption. Audio, persistence and transport are injected ports. |
| `apps/web/src/voice/browserSpeech.ts` | Browser microphone, PCM conversion, playback, ready cue and authenticated HTTP. Currently bound to the primary environment. |
| `apps/web/src/voice/callPersistence.ts` | IndexedDB outbox, scoped by environment and thread. It is a transport buffer, not the authoritative call archive. |
| `ThreadVoiceControls.tsx` / `ChatComposer.tsx` under `apps/web/src/components/chat/` | Phone-width call entry and status, exact model/effort, policy, confirmation and end controls. |
| `apps/server/src/speech/http.ts` | Authenticated `/api/voice`; resolves T3 services and local engine configuration. |
| `apps/server/src/speech/callStore.ts` | File durability, identities, per-call serialization and change notifications. No provider or engine decisions. |
| `apps/server/src/speech/callService.ts` | Raw-save/transcribe/deliver ordering, leases, model validation, status, confirmations and hang-up. |
| `apps/server/src/speech/proxy.ts` | Fixed loopback router API adapter. No cloud recognizer or client-controlled destination. |
| `apps/server/src/speech/callToolGate.ts` | Claude PreToolUse decision persistence and wait. Current classification is provisional. |
| T3 decider, ProviderCommandReactor and ClaudeAdapter | Ordinary turn dispatch, user/assistant history, provider streaming and execution-hook installation. |

Intended flow, with deviations called out below:

1. **Prepare.** On a user gesture, unlock audio and obtain microphone access.
   Load the local outbox or create a call ID. Save its options locally. Open the
   server call log, verify the existing thread and exact provider configuration,
   obtain the router lease, and verify speech readiness. Show completed steps
   from observations. Ring only when microphone, archive, provider/MCP and both
   engines are usable. Current prepare verifies the catalog and lease tenants,
   but does not exercise Claude or attest its Otis tool inventory.
2. **Talk.** Capture an utterance with stable ID and timestamps. Persist it in
   the phone outbox, upload, wait for durable PC acknowledgment, then request
   transcription. The server reads its own saved PCM and saves the transcript
   before returning it. Delivery dispatches an ordinary T3 user turn with an
   immutable identity. Delete the local recording only after delivery acknowledgment.
   Current capture persists only at utterance end. It does not protect a phone
   crash mid-utterance. Chunk journaling is still required for that stronger promise.
3. **Reply.** T3 streams assistant text into the existing chat. The client queues
   completed sentences, requests local TTS, plays PCM, and acknowledges playback.
   Existing history is excluded using initial text offsets. This is sentence-level
   speech streaming; the proxy currently buffers each full TTS response.
4. **Optional tool confirmation.** Under normal permissions the agent uses tools
   like any other T3 chat. If the optional gate is enabled, it persists a pending invocation. A status
   watch delivers it to the phone, which speaks its read-back and listens for an
   answer. That answer follows the same raw-save and transcription path, but
   resolves the bound invocation instead of starting another agent turn.
5. **Interrupt.** Stop playback immediately on the device, discard queued speech,
   persist the playback boundary, then interrupt the ordinary T3 turn. Fence late
   text/audio from that interrupted turn and return to listening. Current UI has
   a button; automatic acoustic barge-in is not implemented. The late-text fence
   and cancellation of pending confirmations are also unfinished.
6. **Disconnect and recover.** Keep recording locally while possible. Show which
   recordings remain unsaved on the PC. Reconnect using the same call/utterance IDs,
   retrieve status, obtain a fresh lease if necessary, replay missing stages, and
   resume only unacknowledged output. Chat WebSocket reconnection and call HTTP
   recovery are separate. Current recovery handles an HTTP retry path, but is
   not complete for reload, server restart, closed calls or multiple tabs.
7. **Hang up.** Stop voice input, finish and retain the current recording,
   close voice resources and release the lease. Leave the ordinary chat's work
   running. A separate explicit interrupt controls that work. Define what happens
   to an optional voice confirmation when its UI detaches without silently approving
   it or stopping the entire chat. Keep failed uploads recoverable. Closing must be repeatable even if
   the router lease already expired. Current client clears its outbox only after
   upload/close responses, but cannot reliably finish a previously closed call.
   It also interrupts the chat and denies later tools, contrary to Jared's correction.

## Durable records and wire protocol

The authoritative root is `ServerConfig.stateDir/voice/calls`. For the isolated
dev home used by the acceptance helper, this is
`<worktree>/.t3-call-acceptance/userdata/voice/calls`. Keep all audio, transcripts,
screenshots and private logs out of ordinary Git and agenda text.

```text
voice/calls/
  _threads/<sha256(threadId)>.json       # { callId }: one active call per thread
  <callId>/
    call.json                           # options, lifecycle, version, lease
    <utteranceId>.pcm                    # mono signed 16-bit PCM, little endian
    <utteranceId>.raw.json               # identity, hash, rate, timestamps
    <utteranceId>.transcript.json        # text, transcribedAt
    <utteranceId>.delivery.json          # messageId, deliveredAt
    <speechId>.speech.json               # output text, at
    <speechId>.played.json               # id, at
    <confirmationId>.confirmation.json  # tool, summary, level, inputHash, decision?
```

`CallRecord` and `StoredConfirmation` live in `callStore.ts`; public records live
in `speech.ts`. `call.json` contains `callId`, `threadId`, `createdAt`,
`modelSelection`, `policy`, `version`, `closed`, `steps`, and optional `lease` and
`leaseUntil`. A raw record contains `id`, `sha256`, `bytes`, `sampleRate`,
`startedAt`, `endedAt`, `savedAt`, and optional `confirmationId`.
`CallUtterance` merges raw, transcript and delivery records for responses.

The archive is not yet a fully append-only journal: PCM and stage records are
retained, but `call.json` and confirmation decisions are replaced. Ordinary T3
history owns agent/tool events; the call archive does not yet mirror every tool
result or launched-agent link from the broader architecture plan.

Writes use exclusive temporary files, file `sync`, close, then rename. POSIX also
syncs the directory. Windows file data is flushed, but equivalent crash durability
of the rename is not proven. Temporary files can remain after failure. JSON reads
are currently unchecked casts; malformed records fail rather than being discarded.
Do not claim corruption recovery or power-loss durability from this implementation.

IDs are caller-generated UUIDs for calls and utterances, restricted to
`[A-Za-z0-9_-]{1,100}` at storage boundaries. The delivery command ID and user
message ID are both `voice:<callId>:<utteranceId>`. Interrupt commands use
`voice-interrupt:<callId>:<operationId>`. Call change `version` is a new UUID,
not a monotonic event sequence. Speech IDs derive from assistant message ID plus
text range; confirmation speech uses `confirm-<confirmationId>`.

| Request | Acknowledgment and replay rule |
| --- | --- |
| `call.open` | Saves call options and thread binding. Retrying the same ID requires identical thread, model selection and policy. Existing closed calls currently reject. |
| `call.prepare`, `call.renew` | Return call status after lease persistence. No microphone upload is consumed by these operations. |
| `call.upload` | Returns an utterance only after PCM and raw metadata are flushed. Same ID must match hash, sample rate, capture timestamps and confirmation binding. Conflicts reject without replacing the original. |
| `call.transcribe` | Requires raw metadata and verifies the saved PCM hash. Returns the saved transcript on replay. A crash after STT but before transcript save may repeat STT, which is safe. |
| `call.deliver` | Requires saved transcript. Dispatches the deterministic T3 command, then writes delivery metadata. A lost response is retried with the same command identity. |
| `call.status`, `call.watch` | Return call state, utterances, unanswered confirmations and played speech IDs. Watch registers a listener before reading the version, with a 25-second keepalive. This is a full snapshot, not a paged event replay. |
| `call.speak`, `call.played` | Persist text before synthesis; same speech ID with different text rejects. Record playback acknowledgment after playback completes. Generated PCM is not cached. |
| `call.confirm` | Requires a pending ID and exact yes/no decision. Opposite decisions on an already answered invocation reject. |
| `call.interrupt`, `call.close` | Dispatch ordinary T3 interrupt; close first writes the closed fence and then releases the lease. Repeated close needs repair for expired leases. |

Idempotency relies on two different mechanisms. File identities deduplicate local
stages. T3 command receipts deduplicate the ambiguous window between accepted
dispatch and writing `.delivery.json`. The engine does not compare entire payloads
on receipt reuse, so the voice layer must keep a command's input immutable. The new
test uses a fake dispatcher with a Set of command IDs; it does **not** establish
real engine deduplication across a restart. Test that integration before acceptance.

There is no exactly-once audible playback guarantee. If playback finishes and its
acknowledgment is lost, replay can repeat that segment. Prefer retained information
over silent omission and explain replay in the UI. Accepted text delivery should
be exactly once in chat; audio playback is acknowledged and may replay.

Timestamp caveat: capture times come from the phone clock; other timestamps come
from the PC. `savedAt` and `transcribedAt` are currently assigned just before their
file write, not after flush completion. They are correlation fields, not sufficient
latency instrumentation. Cross-device timings need clock-offset handling or a
single client monotonic timeline.

## Execution-boundary tool gate

The hook is installed in `ClaudeAdapter.ts` query options as `PreToolUse`, including
ordinary bypass-permissions sessions. `ProviderSendTurnInput.messageId` is propagated
by `ProviderCommandReactor.ts`; the adapter derives `voiceCallId` from a voice
message identity and the hook reads the current session context at invocation time.
Non-call turns return to ordinary provider permissions. This is an SDK execution
hook, not a check after an action runs. Its actual behavior under all SDK paths
still requires integration proof.

The call option `policy` is persisted at open and selected in the call popover:

| Policy | Current behavior |
| --- | --- |
| `confirm-actions` | Handlisted read tools run immediately; handlisted agent actions use `read-back`; every other tool requires `explicit-yes`. |
| `confirm-all` | Every tool waits; agent actions retain the read-back label. |
| `off` | No additional voice confirmation. Ordinary T3/provider permissions still apply. |

Both confirmation levels currently require exactly yes or no; their difference is
only a label. The original recommendation was immediate reads, one-line read-back
for start/steer/stop, explicit yes for deploy/message/delete. Jared subsequently
rejected the extra limits. The intended default is now `off`; retaining the other
policies is the parent's decision. Do not make their completion block an ordinary call
if the parent removes this optional gate.

The pending ID is the first 32 hex characters of SHA-256(tool_use_id). The record
also hashes JSON of the exact tool name and arguments. The hook waits until that
record has a decision, the call closes, or the SDK abort signal fires. Errors deny.
Spoken confirmation captures the currently selected pending ID when listening
starts. Its transcript is added via internal `thread.voice.transcript`, which emits
a normal user message without creating an agent turn. Only trimmed, lowercased
`yes` or `no`, with optional trailing `.`, `!` or `?`, resolves it. "Yes, and deploy"
does not. A confirmation button sends the same ID and decision directly.

Repairs if the optional gate is retained; normal chat permissions remain the default:

- Replace the incomplete name allowlists with trusted tool metadata and explicit
  action overrides. Otis tool schemas expose read-only hints. Unknown dispatchers,
  shell commands and wrappers must not inherit read permission from a name prefix.
  Do not ask the local 27B to classify operations during a call. The parent reported
  an `assess_agent_step` semantic probe waiting on that model; it is not voice evidence.
- Replace raw JSON argument read-back with a safe one-line summary using operation
  and target names. Current summaries can expose sensitive argument values and
  read opaque IDs aloud. Preserve the argument hash privately for exact binding.
- Carry call provenance as trusted server context, not just a client-choosable
  message-ID prefix. Test session reuse, steering, queued turns, restart/resume,
  SDK subagents, nested dispatch and every permitted tool entry point. Confirm
  that a later text turn cannot change context under an earlier voice tool call.
- Interrupt must invalidate affected unanswered confirmations. A stale yes must
  never authorize a replacement tool invocation. Pending ordering currently follows
  hash-sorted filenames rather than request order.
- A spoken answer other than yes/no currently throws before delivery acknowledgment
  and leaves that recording at the head of the outbox. Confirming via button does
  not remove it. Preserve it as a rejected confirmation and let the next answer proceed.
- The current gate does not constrain a launched child's later tools. The parent's
  earlier suggestion to add an Otis caller-bound voice worker policy was explicitly
  superseded by Jared's correction. Reuse existing harness authority; do not implement
  a new restriction from the older review notes. No Otis repository changes or releases
  were made here.

## Router speech contract and call profile

Current source authority is
`A:/Dev/Projects/qwen-local-bench/qwen_profile_router.py`, especially
`configured_speech_backends`, `voice_session_response`, acquisition/renewal/release,
and the `/v1/voice/sessions` handlers. The old
`A:/Dev/Projects/otis-voice/docs/speech-contract.md` is historical context only.

| Operation | Existing adapter behavior |
| --- | --- |
| Acquire | `POST http://127.0.0.1:8085/v1/voice/sessions`, body `{client:"t3-code",ttlSeconds:120}`. Router returns sessionId, expiresAt and configured tenant IDs. |
| Renew | `POST /v1/voice/sessions/<id>/renew`, TTL 120 seconds. Client schedules every 60 seconds. |
| Release | `DELETE /v1/voice/sessions/<id>`. Unknown/expired session returns 404, currently treated as failure. |
| STT | `POST /v1/audio/transcriptions/pcm?sample_rate=N&language=en`, raw PCM, `X-Voice-Session-Id`. |
| TTS | `POST /v1/audio/speech`, model, text, voice `otis`, PCM response and `stream:true`; same lease header. Response needs `x-sample-rate`. |

The correction packet also says Jared wants the 27B retained for triage, in its
later-phase discussion. That does not establish that 27B and these speech tenants
fit together on 16 GB. Preserve the current router lease boundary and give the
parent any actual resource conflict; do not invent a new GPU policy or restart it.

The server expects tenants from `T3_CALL_STT_TENANT` (default
`whisper-large-v3-turbo`) and `T3_CALL_TTS_TENANT` (default `breeze-tts-2`). The TTS
request model is separately swappable with `T3_CALL_TTS_MODEL` (default
`breeze-tts-2`). STT routing is whatever backend the router config selects; the
request has no STT-model selector. Confirm actual tenant identifiers against the
router before relying on defaults. Keep overrides process-local to the dev instance.

There is **no named call-profile selector in the inspected acquire API**. It accepts
client and TTL, starts the configured speech tenants, and returns their IDs.
The current implementation treats the expected pair as the call profile. It checks
that both IDs are included; it does not reject extra tenants or attest GPU occupancy.
Do not label that a verified named GPU profile. The router owns unloading the 27B,
speech startup, existing-job coordination, expiry and family-game yielding. This
parent never restarts or reconfigures 8085.

Risks to resolve with the router owner or adapter:

- Acquisition can wait on active jobs/switching without an observed per-request
  deadline. T3 times out after 90 seconds. The router can finish later and create
  a lease whose ID T3 never received. There is no observed acquire idempotency key,
  cancellation token, or client-owned lease recovery route. Expiry limits leakage.
- Tenant readiness is checked during startup, but renew only extends expiry. A
  locally unexpired lease is not a current engine health observation. No fine-grained
  prepare progress stream is exposed; T3 must show an honest waiting step.
- The proxy discards router `expiresAt`. The call service instead uses local
  now + 110 seconds. Preserve authoritative expiry and reacquire when needed.
- Slow STT/TTS currently holds the per-call mutex. Renewal, interruption, close,
  and confirmation can queue behind it. Move network waits outside state-write
  critical sections with explicit in-flight identities and cancellation.
- DELETE of an expired lease should make repeatable hang-up succeed, while other
  router errors remain visible. Acquire cancellation and late responses need tests.
- TTS buffers the entire PCM response even though `stream:true` is requested.
  Measure sentence buffering before adding a streaming transport. Do not report
  first PCM arrival as first audible output.

## Exact model, thinking and Otis availability

`packages/contracts/src/model.ts` still defaults generic Haiku to
`claude-haiku-4-5`. That default was deliberately not changed globally. The call
popover supplies `claude-haiku-5-5`, preserves the selected provider instance, and
adds `{id:"effort",value:"medium"}` unless a different setting is selected.

`verifyCallModel` in `callService.ts` requires an enabled, installed `claudeAgent`
provider, rejects known unavailable/error/unauthenticated states, requires an exact
catalog slug, and validates supplied options against the model's descriptors.
Absent 5.5 or absent medium is an error. No fallback or silent option deletion is
intended. `ClaudeModelCatalog.ts` passes unknown exact slugs through rather than
mapping them to the generic Haiku alias.

The correction packet reports a web verification of the `claude-haiku-5-5` model
identifier and release. That is parent-reported external evidence, not a successful
call from this environment. Still unverified here: availability of Haiku 5.5
in this account/CLI, advertised and applied medium effort, effort changes on reused
SDK sessions, and actual Otis MCP tool inventory. The validation currently permits
unknown authentication state and warning status. It is configuration validation,
not a live handshake. A custom catalog entry alone proves none of the above.
Do not add a fabricated 5.5 capability descriptor merely to make prepare pass.
No hardcoded Otis endpoint or copied credentials were introduced. The separate call
model text input and Claude-only validation must give way to the normal T3 selector
under Jared's latest direction; retain exact-selection/no-fallback behavior for every
supported provider. Do not silently accept a provider whose voice integration is unverified.

Measure medium versus the provider's supported low/default setting with the same
WAV, model, tools and warmed engines, recording cold prepare separately. Capture
speech end, final transcript, first actual assistant text and first scheduled/audible
audio. Report sample counts and median/range, with provider reasoning/token accounting
only when reported. Current values and thinking overhead are all **null**. Retain
medium as Jared's requested provisional setting; no evidence supports overriding it.

## Current file state

All paths below are relative to the worktree. No file has a passing owner typecheck.
"Implemented" means the code is present, not that its behavior has been accepted.
No production engine fake is wired in; fakes exist only in the new tests.

| File | State and remaining work |
| --- | --- |
| `packages/contracts/src/speech.ts` | Partial: typed call protocol present. One broad optional-field request shape relies on service validation. Add action-specific schemas, durable metrics and compatibility tests. |
| `packages/contracts/src/provider.ts` | Small propagation change present: optional send-turn messageId. Verify every adapter/caller remains compatible. |
| `packages/contracts/src/orchestration.ts` | Internal `thread.voice.transcript` command present. Not a public client command. Check union consumers. |
| `apps/server/src/orchestration/decider.ts` | Transcript-only message event present. Add invariants, archived-thread policy and replay tests. |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` | messageId propagated into normal send-turn request. Recovery, steering and queued-turn provenance are unproven. |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts` | Hook and session call context wired. SDK behavior, hook composition, resume and context races untested. |
| `apps/server/src/speech/callStore.ts` | Storage implementation present; syntax check passes. Repair transactional open/binding, decode/version records, restart recovery and durability tests. |
| `apps/server/src/speech/callService.ts` | Partial lifecycle implementation; syntax check passes. Fix long-held lock, closed recovery, ambiguous dispatch integration, invalid-confirmation queue and lease cleanup. |
| `apps/server/src/speech/callToolGate.ts` | Partial optional gate; syntax check passes. Default-on behavior conflicts with the correction. If retained, metadata, safe read-back and provenance remain unfinished. No new downstream voice policy is requested. |
| `apps/server/src/speech/http.ts` | New route integration present. Verify Effect layer dependencies and request cancellation; avoid exposing raw internal error messages. |
| `apps/server/src/speech/proxy.ts` | Tenant IDs and configurable TTS model added. Legacy path retained. Expiry, error semantics and streamed response still need work. |
| `apps/server/src/speech/callService.test.ts` | 16 synthetic tests written, zero executed. Real temporary files, fake speech/provider ports. Covers save order, conflict, orphan PCM, retry identity, gate and catalog selection. |
| `packages/client-runtime/package.json` | Shared `./voice-call` export added. Check consumer resolution and package typecheck. |
| `packages/client-runtime/src/voice-call/session.ts` | Partial client state machine; syntax check passes. Closed recovery, cancellation, reload, outbox journal, replay and interruption need tests and repairs. |
| `apps/web/src/voice/session.ts` | Compatibility re-export of new shared controller. Its old tests have not been migrated and use incompatible signatures. |
| `apps/web/src/voice/callPersistence.ts` | IndexedDB implementation present. Quota/transaction failure, schema upgrades and multi-tab ownership untested. |
| `apps/web/src/voice/browserSpeech.ts` | Mic warm-up, ready sound and simple silence endpointing present. No output-time acoustic barge-in, chunk persistence or native implementation. |
| `apps/web/src/components/chat/ThreadVoiceControls.tsx` | Partial call popover and controls. No screenshot/runtime proof; unmount currently ends the call and undermines reload recovery. |
| `apps/web/src/components/chat/ChatComposer.tsx` | Existing entry point adapted. Still primary environment only; ordinary interrupt path stops voice. Original NUL bytes preserved, no unrelated cleanup. |
| `scripts/otis-call-acceptance.mjs` | Parent-run acceptance candidate. Syntax checked separately; no browser, provider or engine execution. Limits below. |
| `docs/otis-call/architecture.md` | This design and repair handoff. |
| `docs/otis-call/handoff-phase1.md` | Current evidence and parent run commands, replacing the obsolete investigation-only checkpoint. |
| `docs/otis-call/COMMIT_MSG.txt` | Proposed commit message for parent review. Exactly one task trailer. No commit performed. |

Unchanged but affected: `apps/server/src/speech/proxy.test.ts` has 5 tests;
`apps/web/src/voice/session.test.ts` has 7 tests for the old controller. Preserve
their protections when replacing obsolete contracts: no post-stop agent submission,
no history replay, playback cancellation, and release after late acquisition. Do
not simply delete these tests to obtain green results. Explain that cancellation
now retains raw audio while preventing new work, replacing the old discard contract.

## Known traps and unresolved decisions

- **One writer is assumed.** In-process locks do not protect two servers sharing a
  home. The parent must use an isolated home. `call.json` is written before its
  thread binding; a crash between them can admit another call. Retry does not repair
  this binding. Define transactional/reconcilable open before testing restart.
- **Closed recovery conflicts with open.** Late uploads are intentionally allowed
  after close, but client resume calls open first, which rejects closed calls.
  Separate resuming a live call from draining a closed call's outbox.
- **Unmount is not hang-up.** Current cleanup invokes stop. Navigation, reload and
  React lifecycle cleanup must detach listeners without declaring user intent to
  end the durable call. Handle start/stop/prepare races explicitly.
- **A transport error is not every error.** The client labels model validation,
  storage failure and network failure alike as reconnecting, trapping configuration
  edits behind End. Give recoverable errors specific actions and never claim PC
  retention for audio that is still only on the phone.
- **No audio retention during capture yet.** VAD waits for RMS > 0.015 followed by
  900 ms quiet; maximum recording is 59 seconds. This is rudimentary endpointing,
  not conversational barge-in. Long pauses/noisy input and browser suspension need
  tests. IndexedDB writes start after capture finishes.
- **Output identity can overflow.** Hex-encoding arbitrary message IDs plus offsets
  may exceed the server's 100-character speech-ID limit. Hash the message identity
  with explicit range data. Mark interrupted turn IDs so late deltas stay silent.
- **Status grows with the call.** Each watch reads and returns all utterances,
  played IDs and pending records. The 1000-utterance cap does not bound speech
  segments. Add a compact/versioned recovery strategy before claiming long-call performance.
- **Legacy route remains.** Existing acquire/transcribe/speak clients can still use
  the non-retaining path. This preserves compatibility but does not give them the
  new raw-first guarantee. Document or restrict which UI uses which path.
- **Surfaces differ.** Web is also the desktop content, but Electron authentication
  still needs a smoke test. Native mobile has a separate voice/dictation path and
  is untouched. Primary-environment HTTP auth does not support a selected secondary
  environment merely because the outbox key contains its ID. Remote HTTPS microphone
  permission, relay routing and phone background behavior need explicit coverage.
- **SDK trust is not proven by a hook unit test.** A successful fake hook does not
  prove full-access, subagent, resume or MCP execution honors it. Fail closed for
  unsupported call execution paths until the boundary is established.
- **TypeScript syntax mode matters.** New classes use constructor parameter
  properties; the repo enables `erasableSyntaxOnly`. Node syntax checks do not
  establish compatibility with that mode. Replace these if the owner typecheck
  diagnoses them; do not weaken the repository compiler settings.

Single-caller helpers are deliberate where they define a port: `callStore(stateDir)`
shares lock/watch identity between HTTP and provider hooks; `callPersistence`,
`callToolHook`, model validation and the controller's transport/persistence/audio
ports should remain separate. The private speech-ID encoder has one caller; retain
a dedicated bounded identity function when fixing it because collision/replay rules
need a named owner. Tiny local `now`/active/lease functions express repeated
invariants; no general helper framework is needed. The acceptance CLI wrapper is
an intentional credential-redaction and environment-targeting boundary.

## Offline verification at handover

Use Node `A:/Dev/Tooling/t3-node-v24.19.0/node.exe` with repo-local
`node_modules/vite-plus/bin/vp`. Dependencies are installed. The previous handoff's
missing-architecture and missing-dependencies claims are obsolete.

| Check | Exact outcome |
| --- | --- |
| Server owner typecheck: `node node_modules/vite-plus/bin/vp run --filter t3 typecheck` | Job `31b764af-72fb-4f0c-b127-63ad354f6174` still reports running, exitCode null. stderr contains `VirtualAlloc of 8192 bytes failed with errno=1455` and `fatal error: out of memory`. The native job setup specifies a 4 GiB commit limit. No completed type diagnostics or passing result. |
| Focused tests: `node node_modules/vite-plus/bin/vp test run apps/server/src/speech/proxy.test.ts apps/server/src/speech/callService.test.ts apps/web/src/voice/session.test.ts --reporter=dot --maxWorkers=1` | Job `711a4385-df7e-4b81-84e0-3c1fc8f568d5` is blocked, queue position 1, reason `waiting-for-working-directory-or-output-owner`, exitCode null. Zero tests executed; 28 declared cases across these files. |
| `node --check` on callStore, callService, callToolGate, shared session | Four exits 0. Syntax only; no dependency resolution, type checking or test execution. Logs `.logs/otis-call/syntax-0.log` through `syntax-3.log`, summary `syntax-results.json`. |
| Acceptance helper syntax and final diff whitespace | See the exact final results in `handoff-phase1.md`. |
| Web/contracts/client-runtime typecheck, affected lint/format, build | Not run. Required after repair. |
| Real audio, provider, router, disconnect, UI | Not run in this sandbox. No measurements or screenshots. |

Typecheck logs are under
`C:/Users/PrecisionX/AppData/Local/Otis/build-jobs/logs/31b764af-72fb-4f0c-b127-63ad354f6174/command/c80bcc48-a1f9-4ef8-82e0-60795d3eb698/`.
Keep the full stderr locally; do not print its large Go runtime stack. Two owner
waits returned still-running without a terminal receipt. Process command-line
inspection through WMI was denied, so no process was killed. The parent must have
the build owner reconcile this job and unblock the queue, not bypass its lock or
kill broad process patterns. No source pass/fail conclusion follows from the
allocation failure. The stale test signatures above are source-established defects,
not executed failures.

## Ordered jobs for Sol

These are remaining foundation jobs for GPT-6.1-Sol at high reasoning, not an
invitation to launch workers from this chat. Preserve the current branch and
unrelated files. No live restart, router restart or deployment is authorized here.

1. **Restore a checkable candidate.** Have the parent/build owner reconcile the
   stuck gate. Run affected package typechecks and the focused tests through the
   owner job route. Repair compile errors without weakening contracts. Replace old
   controller tests with behavioral tests under the retained-audio contract.
   Acceptance: server, web, contracts and client-runtime typechecks pass; affected
   lint/format pass; all existing lifecycle protections remain tested; actual counts
   and exit codes are saved, with unrelated failures identified separately.
2. **Finish storage and delivery recovery.** Repair open/binding crash recovery,
   closed outbox drain, write validation, corrupt-record behavior and action-specific
   request validation. Add bounded capture journaling and delivery-stage recovery.
   Acceptance: disposable fault injection at every write/dispatch boundary preserves
   raw bytes, rejects conflicting IDs, and creates one real T3 message/turn across
   lost acknowledgments and server restart. No transcript is processed before raw
   save; no agent sees a transcript before its durable save.
3. **Finish lease and lifecycle concurrency.** Move engine waits outside state locks,
   preserve expiry, handle late acquire, expired release, loss of engine health and
   cancellation. Separate detach, reconnect and hang-up. Acceptance: renewal and
   interrupt proceed while STT/TTS is stalled; stop during prepare leaves no owned
   lease; reload and offline close recover without duplicate work; failed readiness
   is visible and no ready cue sounds early. Use router APIs only.
4. **Apply the corrected chat semantics.** Default additional voice confirmation off,
   use normal harness permissions, and make hang-up release voice without stopping
   the chat. Have the parent decide whether the optional gate stays. If retained,
   repair metadata classification, safe natural read-back, exact invocation binding,
   invalid-answer retirement and cancellation. Acceptance: a chat continues using
   ordinary authorized tools after hang-up; no new caller/child restrictions; optional
   confirmation, if enabled, cannot accept stale/mismatched answers or speak raw JSON.
5. **Use the normal model selector and prove readiness.** Remove the separate call
   model text field and Claude-only product restriction. Validate actual 5.5 identity, supported/applied
   effort and Otis inventory in an isolated ordinary chat. Acceptance: unavailable
   5.5 or medium produces a clear error; no 4.5 fallback; a real read-only Otis tool
   completes before the response; actual model/effort evidence is retained. A custom
   model catalog alone is insufficient.
6. **Finish the phone experience.** Wire environment-specific authenticated transport,
   choose and document native-mobile support, repair sentence IDs and interrupted-turn
   suppression, make voice interruption usable, and distinguish local/PC save states.
   Acceptance: a phone-width browser can prepare, converse, interrupt, confirm,
   reconnect and hang up; text appears in the same chat; desktop authentication and
   remote/relay modes are checked. Native mobile is either implemented and verified
   or explicitly remains an unfulfilled surface requirement for the parent to resolve.
7. **Finish and execute real acceptance.** Use the script below after repairing its
   provisional assumptions. Add stage instrumentation and receipt-based completion
   waits. Acceptance: real recorded WAV through browser capture, real local engines,
   real Haiku plus Otis; raw hashes and exactly-one chat delivery; injected disconnect
   and recovery; phone screenshots inspected by the parent; medium comparison with
   measured delays and a justified recommendation. No fabricated zeroes for missing data.
8. **Review, hand off and release through the parent.** Review the actual candidate,
   update obsolete `docs/internals/voice-input.md` and user documentation, remove
   obsolete assumptions from this handoff, and run final affected owner gates.
   Acceptance: clean reviewed diff, explicit evidence rungs, exact release/rollback
   commands from the live T3 owner, parent commit/push with one task trailer, and
   deployment only through that owner. Leave 8085 untouched.

## Parent-run acceptance helper

`scripts/otis-call-acceptance.mjs` is a runnable candidate for an already-running
isolated dev instance. Exact preparation and invocation commands are in the handoff.
It refuses a home other than this worktree's `.t3-call-acceptance`, requires a
loopback origin and matching thread URL, uses the local CLI to target that home,
and obtains a pairing URL only in memory. It launches a headless installed Chromium
browser through `playwright-core`; it does not download a browser or touch the
connected phone. A recorded PCM WAV is supplied as the browser microphone.

The helper starts the actual call UI, watches requests, captures a 390x844 screenshot,
checks the saved PCM hash and transcript, and looks for one delivered message and a
new completed expected Otis tool in T3 readback. `--disconnect` lets the first upload
reach the server, discards its response, then uses Retry saved speech. This proves
the ambiguous upload-ack window when it passes; it does not prove all mid-call
network failures, server crashes or phone process loss.

It writes only a bounded report and screenshot to ignored `.logs`, not audio or
transcript text. Timings are speech-end-to-transcript HTTP response, first newly
rendered assistant row, and first scheduled AudioBuffer playback. The ready cue is
an oscillator and does not count as reply PCM. First scheduled playback is not an
acoustic measurement; a confirmation read-back could count unless the WAV requests
only an immediate read. Use the same PC clock for this harness's baseline.

Known acceptance-helper limits Sol must address: it checks requested model selection,
but compact CLI readback may not expose the actual provider model; it cannot attest
applied effort. It checks bounded tool activity immediately after first audio, so
late or truncated tool completion can fail a valid run. The DOM observer can see
assistant-row metadata rather than a true first token. It does not test audible
interruption, reload or cloud disconnection. RIFF/WAVE header validation alone does
not validate the PCM format. The first run may expose selector or browser fake-mic
timing issues. Treat its `passed-client-and-storage-observations` status as those
observations only, never the whole phase-1 acceptance claim.
