# Otis Call phase 2 handoff

Task `agenda-task:515bbc54cb61482681e950e524421ce4`.
Recovery fix base `9f38fad19c`, branch `work/otis-call-20261018`, upstream
`origin/work/otis-call-20261018`. Changes remain uncommitted as requested.
Observation date: 18 October 2026, America/Chicago, CDT.

The parent committed the first follow-up as `9f38fad19c` and verified real
60-second lease renewal. The remaining failure stopped queued speech after a
transient voice request error. This follow-up adds independent request retries,
playback recovery and failure screenshots. Changes remain uncommitted. No live
T3, router or dev launcher was changed or restarted. The dev T3 on 7300/15340
belongs to the parent, who will restart it and repeat acceptance. No subagents
were used. Implementation host model and effort attestation remain unknown.

Claude supports tool-free voice. Other voice adapters still reject that mode.
The original requirement to use every provider for voice remains unmet.

## Implementation

| Source                                                                                     | Responsibility                                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/speech.ts`, `provider.ts`                                          | Separate selections, delegation intent, typed started/waiting/progress/done/needs-Jared updates, tool-free session mode.                                                  |
| `apps/server/src/speech/callOperator.ts`                                                   | Durable linked sessions, delegation, update/heard records and request routing. Uses ordinary ProviderService sessions and existing adapters, not a new execution harness. |
| `operatorProtocol.ts`                                                                      | Assistant control blocks, retained state and cross-provider text reconstruction.                                                                                          |
| `callStore.ts`                                                                             | Validated atomic storage for links, settings, jobs and updates alongside call archives.                                                                                   |
| `callService.ts`, `http.ts`                                                                | Authenticated configuration, announcement and heard actions; both model selections survive recording retries.                                                             |
| `ProviderCommandReactor.ts`                                                                | Routes voice turns to the linked voice session and responses to the session that raised an approval/input request.                                                        |
| `ProviderRuntimeIngestion.ts`                                                              | Projects voice text/turn receipts and attributed operator tool activity into the single visible chat.                                                                     |
| `ClaudeAdapter.ts`, `ProviderService.ts`                                                   | Removes voice tools, MCP catalogs, filesystem settings and hooks; denies tool callbacks; rejects unsupported tool-free adapters. Operator permissions stay ordinary.      |
| `ThreadVoiceControls.tsx`, `CallModelSelectors.tsx`, `ChatComposer.tsx`                    | Separate ProviderModelPicker and TraitsPicker instances, defaults and unheard list, reachable in the phone composer call panel.                                           |
| `voice/modelDefaults.ts`                                                                   | Initial catalog preferences only. Execution uses exact saved selections and options.                                                                                      |
| `packages/client-runtime/src/voice-call/session.ts`, `apps/web/src/voice/browserSpeech.ts` | Announce at a microphone pause, retain interrupted updates, acknowledge heard results after playback.                                                                     |
| `scripts/otis-call-acceptance.mjs`, `scripts/lib/otis-call-evidence.mjs`                   | Linked-session receipts and separate voice acknowledgment/operator result stages.                                                                                         |

The voice emits prose first and an optional typed intent afterward. Only completed
assistant output can delegate. The server supplies the exact saved transcript
and recent conversation to the operator. Failed/interrupted voice turns do not
delegate. Streamed and completion-only messages retain one copy of control text.
Control blocks never enter spoken or rendered voice prose.

Done stays pending until a successful operator completion receipt. A failed turn
cannot promote an early completion claim to done. Unknown send outcomes remain
visible and are not automatically retried. One operator job runs per chat;
further requests queue while conversation remains available. Hanging up releases
speech without interrupting provider work. Results persist outside call archives
and remain available to the next call.

Model pairs persist per chat, with an environment-local default. These are T3
preferences, not changes to the providers' global configuration. Updates queue
during microphone activity. Silence-only capture does not become another request.
Routine progress stays in chat; terminal results and questions can be spoken at
a pause. Interrupted results stay unheard. Speak/hold/defer remains future scope.

## Latest parent observations

The parent ran `9f38fad19c` at 390 px with Claude Haiku 5.5 medium for voice
and Codex GPT-6.1-Sol medium for background work. Router speech fix `f3f15fe`
was already live, engines were prewarmed, and the T3 home was isolated.
Chat `5ceaef84-d385-4d49-91f4-164a9b664ad9`, call
`ea34b08a-da07-49c4-a974-8026f4eac90f`, 18 October, 17:48 to 18:00 CDT.

Exact supplied evidence:

- `A:/Dev/Artifacts/agent-packets/otis-call-20261018/phase2-live-3-report.json`
- `H:/AI/QwenRouter/logs/router-backend/router.log`, parent-observed time range above.
- `.logs/otis-call/dev-stdout.log`, read without changing the running server.

The report and router observations establish:

| Observation                         | Result                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| Lease renewal                       | Every 60 seconds, 17:49:10 to 17:59:11 CDT. The prior lease defect passed.                       |
| Speech end to first scheduled audio | 16,484 ms. This is scheduled playback, not acoustic onset.                                       |
| Delivery to first text              | 4,130 ms.                                                                                        |
| First text to first scheduled audio | 842 ms.                                                                                          |
| Speech end to transcript            | 11,250 ms; the router measured about 11.1 seconds. Router warmup is parent-owned.                |
| First sentence                      | Played acknowledgment at 17:48:43.584 CDT.                                                       |
| Second sentence                     | Queued at 17:48:37.085 CDT, zero synthesis attempts.                                             |
| Background result                   | Tool completed at 17:49:13; successful typed result at 17:49:15 CDT. Unheard.                    |
| Failure evidence                    | Endpoint-fetch alert, no non-200 voice responses recorded, deadline expired, screenshot missing. |

These are parent live observations of the base. No live measurements of the
uncommitted recovery fixes were made here.

## Root cause and recovery changes

The original browser fetch trigger cannot be identified from the supplied report.
It lacks the failed action, browser request-failure code and nested exception.
`rpc/http.ts` wraps a failed fetch/read in `RemoteEnvironmentAuthFetchError`;
`voice-call/transport.ts` also wraps exceptions from streamed response handling.
The endpoint label alone does not prove a server outage, an auth refresh race,
a concurrency limit or a shared request abort. No such cause is claimed.
The T3 command scheduler defaults to parallel execution and request signals
are separate. A synthetic concurrent-watch/stream test verifies abort isolation.

The confirmed failure escalation is in
`packages/client-runtime/src/voice-call/session.ts`: `failed()` aborted both
playback and the status watch, set recovery state and offered manual retry.
`ThreadVoiceControls.tsx` only resumed automatically on an `online` event.
A transient failure while the browser remained online therefore left sentence 2
and later operator results queued indefinitely. The prior renewal fix kept the
lease alive independently, matching the parent's log.

The call now retries transient fetch, timeout and temporary HTTP failures at
the operation boundary, starting at 250 ms and backing off to at most 10 seconds.
Retries keep the same call, utterance and sentence identifiers. They resolve the
current environment credentials through the existing T3 command on each attempt.
A status-watch failure does not abort playback or block another request.
Configuration and permission failures remain visible and are not retried.
Malformed audio frames and playback callback failures now retain a permanent
speech error through the environment HTTP wrappers, rather than being mislabeled
as a retryable endpoint outage. An incomplete stream can retry.

Synthesis owns its playback attempts. Before retrying a failed partial sentence,
it cancels that attempt's pending audio nodes. It may repeat the partially heard
sentence after a stream reset. A failed played acknowledgment retries separately
and does not resynthesize a sentence whose audio already finished. Hang-up,
detach and interrupt cancel pending retries. An online event leaves active retry
controllers intact; full preparation resumes only a call already in recovery.
No operator interrupt was added.
Done and needs-Jared updates still wait for a microphone pause and are marked
heard only after their voice reply finishes. Regression tests exercise both
terminal statuses through a failed synthesis and successful recovery.

The screenshot was placed after asynchronous response and receipt drains.
The first speech response never recorded completion in the supplied report;
waiting for every observation could prevent capture. Failure capture now runs
before those waits and before browser close. Streaming `response.finished()`
observations are not gates. A total-deadline failure gets a bounded, two-second
evidence attempt before exit. Screenshot itself has a 1.5-second timeout and
state readback has a 400 ms limit. If Chromium cannot capture, the report records
`screenshotSaved: false` with `screenshotError` or `failureEvidenceError`.
A browser that cannot respond cannot yield a guaranteed image.

The helper also records bounded `voiceRequestFailures` with action, speech ID,
time and browser error code, plus `voiceRetries` with action and attempt.
These fields do not copy audio, transcripts, auth headers, credentials or
arbitrary exception messages. Successful streaming observation is still distinct
from played acknowledgment and heard operator status.

## Offline verification of recovery

Current receipts and logs are under `.logs/otis-call/phase2-recovery-direct`.
The exact commands are in `check-results-final.json` and `check-results-current.json`;
source hashes and final check summaries are in `final-evidence.json`.
The final focused run passed 292 tests across 11 files, exit 0. The
contracts, server, client-runtime and web typechecks passed, exit 0. Client-runtime
and web were rerun after the final retry-policy changes. The evidence/deadline
suite passed 20 tests, exit 0. Affected lint, source and Markdown formatting,
acceptance syntax/help and diff whitespace passed, exit 0. Synthetic screenshot
fixtures prove capture-before-close and deadline behavior, not browser rendering.
Three standalone deadline probes for stuck setup, heard acknowledgment and cleanup
returned expected exit 1 with partial reports and synthetic evidence files. The
actual helper also returned expected exit 1 for an unavailable synthetic WAV,
with its report saved before any browser or T3 CLI launch. No real phone
screenshot or audible recovery was reproduced here.

Focused regressions cover a failing watch during streaming, retained sentence 2,
a lost played acknowledgment without duplicate audio, partial-stream restart,
retry cancellation on hang-up/detach/interrupt, permanent failures and both
terminal operator status types recovering to heard acknowledgment. Existing
provider, protocol, storage, auth, schema and composer checks remain in the suite.

To repeat the changed behavior checks:

```powershell
& $callNode node_modules/vite-plus/bin/vp test run apps/web/src/voice/session.test.ts packages/client-runtime/src/voice-call/transport.test.ts --configLoader native --pool threads --maxWorkers 1 --cache=false --reporter dot
& $callNode --test --test-isolation=none --test-reporter spec scripts/lib/otis-call-evidence.test.mjs scripts/lib/otis-call-deadline.test.mjs
```

Use Node `A:/Dev/Tooling/t3-node-v24.19.0/node.exe`, put its directory first on
PATH and use `GOMAXPROCS=2` for package typechecks. The exact eleven-file focused
command and four `tsgo --noEmit -p <package>/tsconfig.json` commands are retained
in the receipts. No live T3 API requests or browser runs belong to these checks.

Owner queue job `de93ca1d-3b57-4142-89f6-0b75fa590e66` had no admission, logs
or exit code after its ten-minute owner wait. Its next receipt remained queued
at position 17. Direct verification uses a separate output directory. Queue
submission is not passing evidence; no queue state or unrelated job was changed.
The previous broad orchestration suites remain a separate parent host gate:
baseline and candidate probes previously failed at Git spawn with `EPERM`.

## Parent acceptance

Use `test-t3-app`, the phase 1 headless owner launcher and the isolated
`.t3-call-acceptance` home. Create fresh approval-required chats using the phase 1
packet. Reuse provider authentication. Do not use daily state, baked-in origins,
router restarts or the connected phone.

Codex CLI observed here: `0.162.0`, at
`C:/Users/PrecisionX/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe`.
`C:/Users/PrecisionX/.codex` resolves to `D:/MovedAppData/Codex/.codex`, whose
configuration names GPT-6.1-Sol, high effort and an Otis MCP entry. This is
configuration evidence, not proof of execution or the isolated T3 provider's
effective home. Select medium explicitly through T3.

```powershell
$callNode = 'A:/Dev/Tooling/t3-node-v24.19.0/node.exe'
$callRoot = 'A:/Dev/Worktrees/t3-otis-call-20261018'
$callHome = "$callRoot/.t3-call-acceptance"
Set-Location -LiteralPath $callRoot
$env:PATH = 'A:/Dev/Tooling/t3-node-v24.19.0;' + $env:PATH
& $callNode apps/server/src/bin.ts agent providers --base-dir $callHome
# Supply observed instance IDs and inspect each full catalog before execution.
& $callNode apps/server/src/bin.ts agent providers --base-dir $callHome --instance $callVoiceInstance
& $callNode apps/server/src/bin.ts agent providers --base-dir $callHome --instance $callOperatorInstance
```

Supply the fresh chat's URL/ID, observed web origin, an existing Chromium binary
and the same local WAV as the baseline. It should request one read-only Otis
operation and a short spoken result. After confirming the models/options exist:

```powershell
$callArgs = @(
  'scripts/otis-call-acceptance.mjs', '--base-dir', $callHome,
  '--origin', $callOrigin, '--thread-url', $callThreadUrl,
  '--thread-id', $callThreadId, '--instance', $callVoiceInstance,
  '--model', 'claude-haiku-5-5', '--effort', 'medium',
  '--operator-instance', $callOperatorInstance, '--operator-model', 'gpt-6.1-sol',
  '--operator-effort', 'medium', '--operator-effort-option', 'reasoningEffort',
  '--wav', $callWav, '--browser', $callBrowser, '--expect-tool', 'get_task',
  '--width', '390', '--timeout-ms', '900000'
)
& $callNode @callArgs --output .logs/otis-call/phase2-recovery-live
```

The helper saves the exact pair through the authenticated route, reloads the real
controls, follows both linked logs and waits for operator completion. Answer only
the expected approval in the ordinary T3 panel; nothing is auto-approved. Repeat
on fresh chats with `--width 375` and `--hang-up-after-delivery`, each with a new
output directory. Early hang-up must precede the operator completion receipt.
Normal split runs also wait for the result's heard acknowledgment before closing.
Lease renewal already passed on the base. For this fix, verify sentence 2 is
requested and played, then the terminal result is spoken at a pause and
`operator.heard` is true. `deadlineExpired` must be false. Inspect
`voiceRequestFailures` and `voiceRetries` if the endpoint fails again. Confirm a
brief failure recovers without a browser online transition or a manual retry.
Use the helper's `--disconnect-at speech` case on another fresh chat to discard
one accepted synthesis response and prove the queued sentence recovers.
Repeat with speech underway when the result arrives, then pause. The unheard
list clears only after playback. A failed run should retain `phone-call.png`
and its report; unavailable capture must have a named error. The acceptance
deadline includes setup and cleanup, followed only by the bounded two-second
failure-evidence attempt.
Use the operator arguments in this packet for phase 2 acceptance.

Also verify both model/effort pickers mid-call, next-turn application, reload and
default persistence. Speak as work finishes, confirm no interruption, then pause
and listen. Interrupt a result, check the unheard list, hang up and start another
call to hear it. Inspect attributed tools and answer an operator approval and
structured question in the same thread. Confirm later results after hang-up.

## Remaining gates and compatibility

Web and Electron share the controls. Existing environment auth covers local,
cookie, bearer and relay requests, but offline transport tests do not prove a
live remote call. Native mobile retains earlier dictation; native calls/model
controls are unimplemented. There is no new Settings, palette or keybinding entry.

Claude supports tool-free voice. Codex, Cursor, Grok, OpenCode and Antigravity
currently lack an admitted tool-free voice adapter. Their operator path uses
normal ProviderService routing. The parent proved Codex GPT-6.1-Sol medium in
the split; other operator adapters still need live acceptance. Generic selection is
implemented; generic tool-free voice execution remains an unmet requirement.
Automatic T3-process restart recovery and resolving uncertain sends need further
work. Do not describe fixtures or configured catalog entries as live acceptance.

Retain the single-caller helpers as boundaries: `initialCallModels` for initial
preferences, `operatorPrompt` for the packet, `voiceEvent`/`operatorEvent` for role
handling, `operatorReply` for status parsing and `finishOperator` for terminal
evidence. The reply buffer owns cross-provider text assembly. Inlining them would
mix protocol, role and lifecycle decisions.
Retain `CallModelSelectors` as the role-selection UI boundary, `voiceDelegation`
and `operatorUpdates` as protocol readers, and `watchLinkedCallReceipts` and
`hasOperatorResult` as external receipt boundaries. Single-caller service methods
remain API, storage or call-lifecycle boundaries; inlining them would mix those
responsibilities into HTTP routing or event ingestion.

The parent owns acceptance, commit/push and any later release. Use `COMMIT_MSG.txt`.
Exclude `.logs`, recordings, local state and temporary gate configuration. No
production release or router action belongs to this handoff.
The requested task remains incomplete because generic tool-free voice support,
integrated owner checks and acceptance of these fixes remain outstanding.
Current recovery evidence is
`.logs/otis-call/phase2-recovery-direct/final-evidence.json`.
Earlier phase 2 and lease-fix receipts remain under `.logs/otis-call/phase2`
and `.logs/otis-call/phase2-fixes-direct`.

Retain `runAcceptanceWithDeadline` as the report and
process deadline boundary. Inlining it would tie its hung-cleanup tests to real
providers and a browser. The local `checkpoint` closure is intentionally shared
by initial, pre-cleanup and failure writes. `hasUnannouncedUpdates` has multiple
callers and keeps one terminal-status eligibility rule. No new agent system,
model catalog, transport or UI entry point was added.

Retain the new single-caller `playSentence` helper as the audio-attempt boundary;
it keeps cancellation and partial-stream retry out of queue management.
`retry` is shared by request and synthesis operations. The new `errors.ts`
module keeps retry classification shared with transport error construction.
`captureFailure` is shared by normal failure cleanup and the outer deadline
supervisor. None should be inlined into UI rendering or provider orchestration.

Retain the single-caller `voiceRequestError` normalizer as the environment HTTP
adapter boundary. It unwraps the known fetch-error wrappers to preserve a speech
error's retry policy. Inlining it into the transport generator would mix wrapper
handling with streamed PCM parsing.
