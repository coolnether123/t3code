# Voice input

## Browser calls

`ThreadVoiceControls` owns the shared `ThreadVoiceSession` for one environment and
thread. A call attaches speech to an existing T3 chat. It uses the composer's
selected provider, model and options for each recording, with the thread's ordinary
runtime and interaction modes at delivery. A saved recording retains its selection
across retries; changing the selector applies to subsequent recordings.
There is no separate conversation backend, voice tool gate or child-agent policy.
Hanging up releases speech and leaves the chat working. Interrupt is a separate
explicit action that stops playback and interrupts the current T3 turn.

`POST /api/voice` requires orchestration-operate scope. Call requests carry stable
call, utterance and speech IDs. Action-specific validation rejects incomplete
requests before storage or dispatch. The legacy acquire/transcribe/speak union
remains for transport compatibility; it does not provide retained-audio semantics.
The browser call UI uses only the durable `call.*` operations.

The browser journals a cumulative PCM snapshot to IndexedDB roughly once a second,
with at most one journal write in flight. Capture memory is bounded to an utterance
of at most 59 seconds. Slow storage can increase the unjournaled interval; page or
device loss can lose samples since the last completed write. Final capture is
persisted before upload. A journal failure finishes capture and retries the final
snapshot rather than sending unretained speech.

The PC archive is `stateDir/voice/calls/<callId>`. An upload intent binds its PCM
hash and metadata before the PCM and raw acknowledgment records are saved. PCM is
flushed before transcription; the transcript is flushed before ordinary T3
dispatch. The dispatch record freezes the command and permissions across retries.
Its command and message IDs are both `voice:<callId>:<utteranceId>`. T3's durable
command receipts deduplicate a lost dispatch acknowledgment after restart.
File replacements and readers share per-file locks. File data is fsynced; POSIX
also fsyncs the directory. Windows rename power-loss durability remains unproven.
Corrupt records fail visibly and are preserved for recovery.

The server's existing T3 home ownership is required. Opening a call reconciles
active call records under a thread lock, including a missing binding left by an
older interrupted open. Closed calls can reopen for raw outbox drain without
starting transcription or new chat work. Navigating away detaches and retains
the open call, while explicit hang-up persists a closed intent and drains raw
audio. Preparation, renewal, STT, TTS and delivery use separate operation locks;
engine waits do not hold the call state lock. A late acquired lease is released
after cancellation or hang-up.

`voice-call/transport` uses the existing environment HTTP authorization owner.
Requests target the selected environment, with cookies, desktop bearer auth, or
refreshed DPoP credentials and a proof bound to the actual method and URL. The
typed HTTP wrapper now supplies that URL to raw request callbacks. It retains
the existing single refresh on a rejected relay credential.

Speech uses only router APIs on loopback port 8085. Acquire waits for healthy
speech tenants. Renewal checks `/health` and preserves the router's actual
`expiresAt`; failures invalidate readiness. Releasing an expired lease is
idempotent. The speech profile gives the GPU to Whisper large-v3-turbo and Breeze
TTS 2 while the selected cloud provider runs the chat. T3 never starts an engine
directly or restarts the router.

Assistant prose is queued at sentence boundaries. Code and structured JSON stay
in the chat, outside speech. SHA-256 of message ID and explicit text range produces
a fixed 66-character speech ID. Played acknowledgments prevent replay, including
when a client's offset write was lost. Interrupted turn IDs and message IDs remain
silenced across reload. Status carries at most 64 recent utterances and 128 played
IDs; older individual records remain addressable for outbox recovery. The archive
has no call-length or utterance-count cap.

The ready cue means microphone and local speech are ready, with a catalog-valid
model selection. It is not provider or MCP runtime attestation. The parent-run
acceptance helper checks real provider receipts, tool completion, raw hashes and
chat persistence. Native mobile calls and live desktop, remote and relay
acceptance remain separate requirements. See `docs/otis-call/handoff-phase1.md`.

## Native mobile dictation

The native mobile app retains its existing dictation path. Transcription edits a
composer draft without submitting an agent turn. It uses temporary audio and
local iOS transcription; it does not implement durable calls or PC retention.

The shared `voice-input` controller binds the transcriber and locale at prepare,
then checks draft ownership and revision before inserting a result. Cancellation
invalidates insertion immediately. Resources stay owned until native work settles,
because Apple's transcription operation cannot be interrupted after starting.
