# Otis Call architecture

Task `agenda-task:515bbc54cb61482681e950e524421ce4`.
Phase 2 candidate follows baseline `6f18caa404` on `work/otis-call-20261018`.
Updated 19 October 2026, America/Chicago, CDT.

Jared's correction packet at
`A:/Dev/Artifacts/agent-packets/otis-call-20261018/jared-corrections-20261018.md`
governs this work. Calls attach local speech to an ordinary T3 chat. T3's normal
selector supplies the model. Ordinary harness permissions govern tools and
children. Hanging up never stops chat work. Speak natural prose, never tool JSON.
The parent directed complete removal of the additional voice confirmation gate.

Phase 2 adds linked voice and operator sessions behind the same visible thread.
Native voice tools remain disabled. A server-enforced control protocol admits one
read of saved run status or the local agenda per turn, with a 2.5 second execution
deadline and cancellation. Other tool work goes to the operator with ordinary
harness permissions. This keeps ambient MCP configuration and hooks out of voice
sessions. Claude admits this isolation; other adapters remain operator-only until
they can enforce it.
Opening a call prepares the idle native query without offering a message or
creating a turn, so CLI initialization overlaps listening. Merely allocating a
provider thread does not start that query.
`apps/server/src/speech/callOperator.ts` owns durable links, delegation, typed
updates and heard records. Operator activity projects into the visible chat.
Hanging up releases speech while provider work continues. Model pairs persist
per chat with an environment default. The browser queues results during speech
and requests a voice announcement at a pause. See `handoff-phase2.md` for checks
and explicit compatibility limits. The remaining sections describe the phase 1
speech/archive foundation.

Announcement prompts use saved operator updates inside the linked voice session.
Their internal triggers add no chat messages or notification items. Background
progress stays in the compact call bar and durable call-store updates. Results
and useful findings also enter the thread as notices. The model names the receipt
IDs covered by a reply. Unrecorded thread notices retry from durable receipts with
the same command identity on the next update, voice turn or call.
Only the covered IDs become eligible for a full-playback heard
acknowledgment. Interrupted or omitted results remain unheard. A compact summary
and open items persist per thread for later calls. Generated text and interrupted
audio-sample receipts never establish an exact heard word offset.

The active web call stays in a compact bar beside the conversation. Settings use
T3's existing popover portal and collision positioning, with dynamic viewport
and safe-area limits. Ending a call closes local microphone and playback before
network cleanup; the closed outbox retains raw speech until the PC saves it.

Starting from a new-chat draft first uses T3's ordinary create-thread command
with the draft's project and picked voice model. Audio unlock happens in the
tap, before waiting for creation. Both role selections then travel through
`call.open`. The draft route holds automatic promotion during the call so its
first turn cannot unmount audio. Hang-up allows promotion and leaves work
running. Closing an absent call archive is idempotent, allowing an empty
rejected open to dismiss the panel.

Both model pickers validate remembered selections against T3's visible catalog.
Hidden choices fall back to the saved call default, T3's default selection,
then the first visible model. The optional response `defaultModels` keeps the
saved call default available even when a thread remembers hidden models.

## Owners and flow

| Owner                                                 | Responsibility                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/speech.ts`                    | Durable call protocol and action-specific request validation; legacy speech requests remain compatible.            |
| `packages/client-runtime/src/voice-call/session.ts`   | Capture journal, durable outbox, resume, sentence playback, interrupt and detach/hang-up lifecycle.                |
| `packages/client-runtime/src/voice-call/transport.ts` | Selected-environment HTTP requests through existing cookie, bearer and DPoP authorization.                         |
| `apps/web/src/voice/browserSpeech.ts`                 | Microphone PCM, bounded journaling, ready cue and cancelable playback.                                             |
| `apps/web/src/voice/callPersistence.ts`               | IndexedDB transactions scoped to environment and thread.                                                           |
| `apps/server/src/speech/callStore.ts`                 | Validated archive records, atomic writes, per-file locks, thread reconciliation and change watches.                |
| `apps/server/src/speech/callService.ts`               | Raw-save, transcript-save and ordinary dispatch ordering; speech lease and lifecycle.                              |
| `apps/server/src/speech/http.ts`                      | Existing authenticated voice route, T3 services and error classification.                                          |
| `apps/server/src/speech/proxy.ts`                     | Fixed loopback router APIs, actual expiry, renewal health and idempotent release.                                  |
| Existing T3 engine and provider adapters              | Persisted message/turn, durable command receipt, tool permissions and provider execution. No voice execution hook. |
| `scripts/otis-call-acceptance.mjs`                    | Parent-run browser, real-engine and provider receipt checks in an isolated home.                                   |

Typed messages use the same durable outbox and stable voice-message delivery IDs
as transcripts, skipping recording and STT. They can dispatch while speech engines
prepare; replies wait for audio readiness. A slow start speaks one short ready
line per call. Native clients can use the shared protocol but still lack call UI.

The browser saves capture locally before uploading. The PC saves an immutable
upload identity, raw PCM, transcript and dispatch command in that order. The
existing engine deduplicates stable command IDs after a lost acknowledgment.
The browser discards a recording only after delivery acknowledgment, or after a
closed call has acknowledged raw-only drain. Speech output IDs hash message ID
and range, with durable played records. Interrupted turns stay silent. A queued reply finishes an active microphone
capture before playback. Its raw input remains queued until playback and the
current chat turn finish, then uses ordinary delivery. Durable turn state governs
work-in-progress even during provider startup.

The router owns speech process startup and GPU admission. Breeze TTS 2 and Whisper
large-v3-turbo are installed according to the parent. No download or router
change is needed. The cloud chat model does not need the local 27B resident.

## Incremental replies

The controller extracts complete natural sentences during streaming, keeps three
in lookahead and refills without truncating the retained answer. The ordinary
provider turn input adds user-level brevity guidance for durable voice message
IDs; saved transcript and permissions stay unchanged.

For `call.speak` with `streamAudio:true`, the existing authenticated HTTP route
returns newline-delimited SpeechResponse PCM frames and a final `complete:true`.
The router proxy preserves PCM16 sample boundaries and does not buffer the whole
response. The browser schedules chunks on its audio clock as they arrive and
acknowledges the sentence only after playback ends. Interrupt cancels the request,
all scheduled nodes and remaining sentences. Buffered legacy responses still work.
The acceptance helper reports sentence availability, TTS duration and first audio
separately. Real latency and audio quality remain parent-run acceptance.

## Archive and recovery

`stateDir/voice/calls/<callId>` contains `call.json`, plus utterance `.upload.json`,
`.pcm`, `.raw.json`, `.transcript.json`, `.dispatch.json` and `.delivery.json`
records. Output uses `.speech.json` and `.played.json`. `_threads/<hash>.json`
is a repairable binding; active call records are authoritative during open. Closing
removes only that call's binding under the thread lock. A closed archive may drain
raw audio but is never recovered as an active call. The same Start action then
creates a fresh call, including after another device has closed the old one.
IDs are validated at request and file boundaries. Conflicting identities and
corrupt records fail visibly without overwriting PCM.

Speech waits hold an operation lock, separate from the call state lock. Renew,
interrupt and close can proceed during stalled STT/TTS. State updates reread the
current record so an older operation cannot resurrect a lease or reopen a closed
call. Status returns bounded recent records; full recovery addresses individual
utterance and speech IDs. Raw archives have no utterance-count cap.

The server owns a deadline for each acquired speech lease. Renewal replaces the
deadline, and expiry closes the call, removes its thread binding and releases
speech. A lost phone connection therefore cannot leave a call open indefinitely
in the running server. This deadline does not interrupt provider work.

Acquisition waits through the router's 600-second startup budget with a 660-second
server deadline and 720-second browser deadline. Node HTTP avoids fetch's shorter
headers deadline. Cancellation still receives a late lease grant and releases it.
The phone toolbar stays mounted through collapsed composer and tool approvals.

The server must exclusively own its T3 home. File data is fsynced and POSIX
directory entries are flushed. Windows power-loss durability of replacement is
unproven. Partial/corrupt files are retained, with no automatic destructive repair.
Journaling is roughly once per second with one write in flight. Slow storage and
browser suspension can increase the unjournaled interval. This is pause-based
endpointing with an explicit interrupt button, not acoustic barge-in.

## Ordered jobs for Sol

These retain the original job order. The current implementation replaces the
unfinished-code descriptions in the earlier architecture handoff, which remains
available in Git history.

1. Restore a checkable candidate. Compiler issues and stale controller tests are
   repaired. Final commands, exits and counts belong in the phase 1 handoff.
2. Finish storage and delivery recovery. Implemented with synthetic write faults,
   corrupt-record preservation, outbox reload/drain, and a real T3 engine/SQLite
   restart test proving one persisted message and one turn. Speech/provider ports
   remain synthetic in that offline test.
3. Finish lease and lifecycle concurrency. Implemented and tested with deferred
   engines, late acquisition, failed renewal, detach, cancellation and raw retention.
4. Apply corrected chat semantics. The gate, Claude hook, confirmation protocol
   and confirmation-only orchestration command are removed. Hang-up releases voice
   without issuing a turn interrupt. Delivery uses the thread's ordinary permissions.
5. Use the normal model selector. Implemented across provider instances without a
   Claude restriction. Exact model/options are validated without fallback. Actual
   Haiku 5.5, medium and Otis execution remain parent-run runtime acceptance.
6. Finish the phone experience. Browser controls, environment auth, recovery,
   fixed-size sentence IDs, interruption and save wording are implemented. A phone
   browser is the phase 1 client. Native mobile calls remain an unfulfilled client
   requirement for the parent to resolve. Electron, HTTPS remote and relay need
   live acceptance; offline auth tests do not establish those workflows.
7. Execute real acceptance. The helper is ready for parent use outside the sandbox.
   It validates PCM WAV input, watches new provider receipts, checks actual model
   evidence and SDK-configured effort, and supports dropped stage responses,
   reload and hang-up-before-completion. No real measurements exist from this chat.
8. Review, hand off and release through the parent. Source and documentation are
   reviewed locally. The parent owns commit/push and real acceptance. The live T3
   owner must supply release and rollback commands. Nothing is deployed here.

## Remaining acceptance boundaries

The ready cue attests microphone and speech readiness plus catalog validation,
not an already exercised cloud provider or Otis inventory. The acceptance helper
requires a completed real Otis tool and provider model evidence. It reports
SDK-configured effort separately from provider-attested effort, leaving absent
attestation null. A configured custom model alone is insufficient.

Real audio quality, phone-width screenshots, audible interruption, phone process
loss, desktop authentication, relay/HTTPS and provider cloud disconnection remain
parent checks. Scheduled playback time is not acoustic onset. No latency or
thinking-setting recommendation can be derived from the offline fixtures.
