# Otis Call phase 2 handoff

Task `agenda-task:515bbc54cb61482681e950e524421ce4`.
Fix base `fd058b5131`, branch `work/otis-call-20261018`, upstream
`origin/work/otis-call-20261018`. Changes remain uncommitted as requested.
Observation date: 18 October 2026, America/Chicago, CDT.

The parent committed and pushed the split as `fd058b5131`. A real isolated
390 px call with Claude Haiku 5.5 medium for voice and Codex GPT-6.1-Sol
medium for background work reached voice playback and an attributed operator
result. Renewal and result speech failed in that run. The uncommitted fixes
below need the same live acceptance repeated. No live T3 or router changes,
restarts or subagents were used for these fixes. Implementation host model and
effort attestation remain unknown.

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

## Parent observations and follow-up fixes

Parent acceptance of `fd058b5131`, 18 October, 12:34 to 12:41 CDT, used chat
`4534e364-4419-4991-9c3b-2169cafdbdee`. These are parent measurements, not
reproductions in this sandbox. Router evidence is
`H:/AI/QwenRouter/logs/router-backend/router.log`.

- The lease was acquired at 12:39:25, never renewed and expired at 12:41:25.
- Whisper finished at 12:39:46 after 9.3 seconds in the router. Voice audio
  played by 12:39:56; Breeze synthesis took 4.1 seconds. Exact speech end and
  acoustic onset are unavailable, so acknowledgment latency remains null.
- The voice turn completed at 12:39:53 CDT. The background GPT-6.1-Sol medium
  session ran attributed Otis tools and handled one approval in the same chat.
  Its typed done result arrived at 12:40:26 CDT. It was not spoken.
- The helper waited past its deadline and the host killed it after 30 minutes.
  No report was saved. This run did not pass final acceptance.

The fixes address three source-established lifecycle gaps:

1. Renewal belongs to the active call, with an abort controller that survives
   voice completion, background waits and call error presentation. Hang-up and
   detach cancel it. The existing 60-second Effect loop remains, without an
   extra scheduler yield between iterations that already sleep and await HTTP.
   An attached status watch also renews a valid lease with at most 60 seconds
   left. Its existing 25-second heartbeat supplies a second renewal path.
   Watch and explicit renewals share an operation lock, separate from engine work.
2. Silence-only microphone completion now removes its partial journal and leaves
   `listening` before queued speech runs. Previously `speak()` refused that state.
   Pending results take priority over reopening the microphone after playback.
   Every ready call response can advance the pause queue, including a renewal
   response if the watch is delayed. Terminal update prompts request a short
   natural result or question; routine progress remains silent. Heard acknowledgment
   still requires the completed voice reply to finish playing.
3. `scripts/lib/otis-call-deadline.mjs` supervises setup, receipt waits, heard
   acknowledgment and cleanup under one deadline. It writes an initial report,
   saves a partial report before cleanup, and checkpoints failure synchronously
   before requesting browser close. It is the sole report writer. CLI preflight
   is asynchronous and bounded by the remaining deadline. The helper exits after
   the supervisor returns, so abandoned promises cannot retain the host. A timed
   out report sets `deadlineExpired: true`. Missing observations stay null.

The precise browser event that stopped the parent's first renewal is not
reproduced here. The source gaps and synthetic regressions above are verified
separately from that live failure. Repeat acceptance to establish the runtime fix.

## Offline verification of the fixes

Check receipts are in ignored
`.logs/otis-call/phase2-fixes-direct/check-results-final.json`,
`check-results-server-final.json` and `check-results-final-correction.json`.
The latter receipts supersede the intermediate server failure. Full logs stay
beside that receipt. The first intermediate run exposed a timer diagnostic and
sandbox denial of child-process test fixtures. Production code retains Effect
scheduling. Deadline tests now exercise hung setup, heard acknowledgment and
cleanup in-process with a deterministic clock. No existing test contract was weakened.

The final focused suite passed 280 tests across 11 files, exit 0. The Node
evidence/deadline suite passed 17 tests, exit 0. The focused suite covers call
protocols and storage, delegation, hang-up continuation, both adapters' recovery
contracts, the voice controller, browser speech, model defaults, composer
lifecycle, authenticated transport and wire schemas. Syntax, help, affected lint
and affected source formatting passed, exit 0. The only lint warning in an
affected file is the pre-existing iterable spread in `CallOperator.drain`.
Contracts, client-runtime and web typechecks passed with exit 0. The server
check passed too; the final rerun after the fixture's clock correction is saved
in `check-results-final-correction.json`. The earlier check exposed the real
clock-access diagnostic in the new fixture. It now reads the Effect clock
without starting a test runtime or changing production time semantics.
The actual acceptance entry point also returned expected exit 1 for a missing
synthetic WAV and saved a failed report before any CLI or browser launch.
Three standalone synthetic deadline probes also returned expected exit 1 and
retained `operatorResult` in failed reports with `deadlineExpired: true`. They
covered stuck setup, heard acknowledgment and cleanup, including a close callback
that never resolves. Their private evidence is `deadline-{setup,heard,cleanup}`
under the direct log directory. They do not launch Chromium or contact T3.
No live latency, renewed router lease or spoken operator result is claimed here.

To repeat the changed behavior checks independently of the queued launcher:

```powershell
& $callNode node_modules/vite-plus/bin/vp test run apps/web/src/voice/session.test.ts apps/server/src/speech/callService.test.ts apps/server/src/speech/callOperator.test.ts --configLoader native --pool threads --maxWorkers 1 --cache=false --reporter dot
& $callNode --test --test-isolation=none --test-reporter spec scripts/lib/otis-call-evidence.test.mjs scripts/lib/otis-call-deadline.test.mjs
```

Use Node `A:/Dev/Tooling/t3-node-v24.19.0/node.exe`, put its directory first on
PATH, and set `GOMAXPROCS=2` for package typechecks. The exact eleven-file focused
command and four `tsgo --noEmit -p <package>/tsconfig.json` commands are retained
in the check receipts. Production behavior changes are limited to the call
controller, lease watch and terminal-update prompt. UI layout, model selectors,
wire schemas and environment authorization are unchanged by this follow-up.

The owner queue was also submitted the exact verification command:

```powershell
& A:/Dev/Tooling/t3-node-v24.19.0/node.exe .logs/otis-call/phase2-fixes/verify.mjs
```

Job `59927031-94ef-44cd-ae6a-c4420e6623c3` returned still-running after a
ten-minute owner wait. Its next receipt showed blocked at position 16,
`waiting-for-earlier-command`, with no admission, logs or exit code. The direct
fallback uses a separate output directory and Node 24 first on PATH. The queued
job is not passing evidence and was not cancelled or reconciled here.

The earlier broad orchestration checks remain a separate host gate. Both baseline
and candidate ingestion probes failed at Git spawn with `EPERM` during phase 2.
The earlier owner integration job `e543a158-d160-46d4-801b-bba96adb619a` also lacked
an exit receipt in the prior handoff. No new claim is made about its current state.
Parent rerun of those two owner suites:

```powershell
& $callNode node_modules/vite-plus/bin/vp test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts --configLoader native --pool threads --maxWorkers 1 --reporter dot
```

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
& $callNode @callArgs --output .logs/otis-call/phase2-fixes-live
```

The helper saves the exact pair through the authenticated route, reloads the real
controls, follows both linked logs and waits for operator completion. Answer only
the expected approval in the ordinary T3 panel; nothing is auto-approved. Repeat
on fresh chats with `--width 375` and `--hang-up-after-delivery`, each with a new
output directory. Early hang-up must precede the operator completion receipt.
Normal split runs also wait for the result's heard acknowledgment before closing.
For this fix, keep the normal call open past two minutes and confirm router
renewal while the operator is waiting and after voice completion. Confirm the
terminal result is spoken at the next pause and `operator.heard` is true in the
report. `deadlineExpired` must be false. Repeat with speech underway as the
result arrives, then pause. The visible unheard list must clear only after playback.
The total helper deadline includes setup and cleanup; a failed run must leave
`report.json`, even when heard acknowledgment never arrives.
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
The earlier implementation checkpoint is
`.logs/otis-call/phase2/final-source-manifest.json`. Current fix receipts are
under `.logs/otis-call/phase2-fixes-direct`.
The current source hashes and consolidated check results are in
`.logs/otis-call/phase2-fixes-direct/final-evidence.json`.

Retain `runAcceptanceWithDeadline`, a new single-caller helper, as the report and
process deadline boundary. Inlining it would tie its hung-cleanup tests to real
providers and a browser. The local `checkpoint` closure is intentionally shared
by initial, pre-cleanup and failure writes. `hasUnannouncedUpdates` has multiple
callers and keeps one terminal-status eligibility rule. No new agent system,
model catalog, transport or UI entry point was added.
