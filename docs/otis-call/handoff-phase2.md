# Otis Call phase 2 handoff

Task `agenda-task:515bbc54cb61482681e950e524421ce4`.
Natural-call follow-up base `befd85b245`, branch `work/otis-call-fixes-20261019`,
upstream `origin/work/otis-call-fixes-20261019`. No deployment is authorized.
Observed 19 October 2026, America/Chicago, CDT. Earlier sections retain their
historical evidence and acceptance limits.

## Current follow-up: the first real phone call

Jared's 22:49 CDT phone call exposed a long-recording failure and hang-up that
waited for the network. The base64 regexp in the server upload exhausted its
stack. `scripts/lib/otis-call-upload.test.mjs` sends a synthetic minute of
48 kHz PCM through the real client encoder and server upload at
`node --stack-size=120`. It fails against `befd85b245` and passes with the fix
in `f25f94ccce`. Client encoding alone also accepts a synthetic 90-second
payload; the server's existing one-minute recording limit is preserved.

Hang-up stops local audio and shows Call ended before network cleanup. Close
runs independently of raw upload, with closed outbox data retained for automatic
retry. The server schedules closure and speech release at the lease deadline;
renewal replaces that deadline. Provider work continues after hang-up.

Capture uses an audio timeline, with 1.85 seconds for short starts or trailing
fragments and 1.05 seconds for sustained speech. No partial transcription service
is used. Word-specific intent remains an audio heuristic during capture; the
voice prompt also allows a completed `<otis-hold/>` response for thinking aloud
or an update needing no reply. Hold is stripped before projection and playback,
and completed silent replies return the phone to listening.

The pure `shouldEndTurn` helper is an intentional test boundary. Keep it separate
from microphone ownership so its timing decisions can be tested without audio
devices. The compact bar and the acceptance helper's button and region names
are preserved. Web and Electron share this path. Native mobile still has only
its earlier dictation path.

Direct check receipts and complete logs are in
`.logs/otis-call/natural/final/checks-complete.json`. The parent owns isolated
browser and real-call acceptance. No dev server, browser, live T3 write,
restart or deployment was performed. The only router session generated the
filler assets below and was released.

Offline checks passed 188 tests across the focused web voice, client-runtime
voice-call and server speech suites, plus 15 evidence/upload tests. Web,
client-runtime and server typechecks, changed-file lint and formatting returned
exit 0. The final call-control prefix correction also passed its 70-test rerun.

Listen for a pause after "Well, um", a short question with no filler, a silent
"hang on", and ordered sentences on a longer reply. End the call during upload
and with the PC unreachable. Confirm the microphone and playback stop at once,
the phone remains ended, and raw speech eventually reaches the closed archive.
Also verify 375/390 px Safari and answering an approval with the bar visible.

## Previous follow-up: calls from a new chat

Jared reported the mobile Call Otis flow broken around 00:00 CDT on 19 October 2026. The parent reproduced a draft route sending a local thread ID to
`call.open`, which rejected it before creating a call archive or contacting
the speech router. Live T3 remains at the parent-reported `c84b1fec28`.
This candidate is uncommitted and changes no running server or router.
The parent's `apps/server/package.json` edit is preserved. No subagents or
computer use were used.

`ChatView.tsx` now supplies the call controller with an `ensureThread`
callback. It uses the existing `threadEnvironment.create` command, the draft's
preallocated thread ID, project, branch, worktree, runtime permissions and
interaction mode, and the picked voice model/options. The controller unlocks
audio in the original tap, then waits for thread creation before `call.open`.
The open carries both voice and operator selections through the existing call
configuration path. Picker changes on an uncreated draft stay local until open.
Saving an environment default becomes available after creation.

The draft route defers its automatic promotion while the call is active.
The first voice turn can therefore start without unmounting the microphone
and playback controller. Hang-up permits ordinary route promotion and leaves
operator work running. Leaving the route explicitly still detaches the call.

`CallService` accepts closing a missing archive as an idempotent no-op. A
rejected open with no capture can clear its local journal and reach idle.
The controls collapse their expanded panel at idle. Existing archives still
close and release their leases; retained audio, corrupt archives, identity
mismatches and failed close requests keep their existing recovery behavior.

`SpeechResponse.defaultModels` is optional and returns the saved environment
call default separately from remembered per-thread models. Both pickers use
the same visible catalog as the normal T3 picker. A hidden remembered or
composer selection falls back to that role's visible saved call default,
then visible `defaultModelSelection`, then the first visible model. Fallback
preserves the chosen selection's options, including medium effort. A catalog
with no visible model disables Start instead of selecting a hidden model.
Initial voice preference remains Haiku 5.5 medium when visible.

Retain the new single-caller `buildVoiceThreadCreateInput` helper as the
ordinary thread-command mapping boundary. Its focused check verifies draft
identity, project, permissions and the picked model without mounting the full
chat view. `ensureVoiceThread` is the command receipt boundary. No new
provider, execution path, permission gate or chat was added.

Owner checks and full logs are under `.logs/otis-call/phase2-draft`. Run:

```powershell
& 'A:/Dev/Tooling/t3-node-v24.19.0/node.exe' `
  .logs/otis-call/phase2-draft/verify.mjs `
  .logs/otis-call/phase2-draft/owner
```

Final offline receipts are in `phase2-draft/direct-final/check-results.json`.
All gates returned exit 0. The focused selection passed 274 tests across 11
files, including draft command mapping and create-before-open ordering, audio
unlock in the tap, first-turn route retention, creation failure dismissal,
empty rejected-open close, both hidden-model fallback chains, response schema
compatibility and the existing operator, playback, filler and auth checks.
The separate acceptance evidence/deadline helpers passed 22 tests. Contracts,
server, client-runtime and web typechecks, targeted lint, formatting,
acceptance-helper syntax and diff whitespace checks passed. Lint reports 46
warnings in the existing React effect sites. No lint rule was disabled.
`source-before.json`, `source-after.json` and `complete.json` establish that
production and test sources stayed unchanged during the final run, completed
19 October at 00:38:50 CDT.

The first run passed 273 of 274 tests. Its rejected-open fixture already had
an active call in the same thread and hit that guard instead. The fixture now
uses a separate synthetic draft ID. The web typecheck also caught optional
callback typing, an incorrectly referenced prop and fixture typing errors;
all are fixed. Markdown formatting initially failed because the CLI could
not spawn its worker. `.logs/otis-call/format-api.mjs` now calls the same
installed oxfmt API with the repository's unchanged formatting options.
It checks all 19 affected source and Markdown files without spawning that
worker. The wrapper and source manifests are ignored local evidence.

The selection tool has no registered non-.NET policy for this repository, so
the repository and handoff own this check selection. Queue jobs
`c97bb64a-2519-452b-a011-17e14cffc5b6` and
`f2e550aa-d020-44c1-a4cf-18adb6f0d1de` each remained unadmitted after their
ten-minute owner wait. Readback reports `blocked`, waiting for the working
directory or output owner, positions 4 and 5, with null exit codes. The
direct runs use separate output directories. Queue state, other jobs and
running servers were left intact. Queue submission is not passing evidence.

The parent still needs a real iPhone Safari call over Tailscale from a fresh
New thread draft. Confirm the draft project, both selected models and medium
effort, one visible conversation, natural speech, no JSON, and continued
operator work after hang-up. Verify the first voice turn keeps audio attached
and the route promotes after hang-up. Reproduce a rejected open with no audio,
tap End call and confirm the panel disappears with no Retry saved speech.
With GPT-5.6-Sol hidden, exercise visible saved defaults, hidden saved defaults
falling back to GPT-6.1-Sol medium, then first-visible fallback, for both roles.
Repeat the existing saved-call recovery and mid-call picker checks.

Web, Electron and phone Safari share these controls. Local, remote and relay
requests still use the selected environment's existing transport. Native
mobile calls and non-Claude tool-free voice adapters remain the earlier
unimplemented gates. This patch does not establish live browser, audio,
provider-model or network acceptance.

## Speech fillers

The shared filler delay is 1,800 ms after submission for spoken replies.
A completed delegation without prose plays an existing acknowledgment clip
immediately, even if the model also emits a hold marker. The server preserves
this decision as `voiceDelegation` on the conversation message while stripping
control text. Delegation takes precedence over hold. A true hold stays silent,
and quick spoken replies cancel filler before it starts. If prose arrives
after the delay, filler may begin while sentence synthesis is pending.
Real audio cancels the timer; an already playing filler finishes before reply
audio is scheduled. Reply audio still streams per sentence.

The follow-up from `7914a0db87` has direct checks and full logs under
`.logs/otis-call/delegate-ack/`. Focused voice/UI tests passed 194 tests and
the evidence suite passed 14, all exit 0. Web, client-runtime and server
typechecks, changed-file lint and formatting passed with exit 0.
It changes the shared call session, server voice
projection and prompt, and web/Electron message mapping. Native calls remain
outside the implemented mobile path. No new transport origin, provider adapter,
entry point, server restart or deployment is involved. The parent still owns
the isolated real-call acceptance for this follow-up.

The lazy `fillerClips.ts` chunk contains 24 mono PCM16 clips at 24 kHz. It is
2,270,028 source bytes, or 1,280,887 gzip bytes, with 1,701,120 PCM bytes. Clips last
0.72 to 2.72 seconds. Selection excludes the last four clips. Ordinary chat
does not import this chunk. There is no router request for filler during a call.

WAVs and the text/duration manifest are local at
`A:/Dev/Artifacts/otis-voice-clips-20261019/fillers/`. Generation checked the
live call archives for a recently changed unclosed call before opening a session
and before each clip. One router voice session generated the clips using
`breeze-tts-2` and `otis`, then returned HTTP 200 on release. No live T3
data was written. Only PCM is bundled; WAV headers and the private manifest stay
outside Git.

Keep `TurnFiller` as the shared timing and playback boundary. Tests cover the
delay, real audio winning the timer, hold suppression, clip rotation and ordered
playback. The parent still owns audible quality and Safari acceptance.

## Previous follow-up after live-6

The parent committed the handoff and panel fixes as `36e4e2bd2d` and accepted
the 375 px panel in `.logs/otis-call/phase2-live-6`. The voice picker and footer
actions fit, no JSON appeared, and the voice spoke the operator failure
naturally. That is parent evidence for the base, not a live run of this patch.
No new browser launch or live T3/router change was performed here. Preserve
the parent's pre-existing `apps/server/package.json` edit; it is unrelated.

The linked operator log at 20:01:27 CDT contains `runtime.error` with
`codexErrorInfo: serverOverloaded`, `willRetry: false`, and the selected-model
capacity message. A failed `turn.completed` follows ten milliseconds later.
`CallOperator` previously treated either terminal receipt as final and asked
Jared immediately. The canonical event pairs are in the retained
`events.t3-call-operator-b2172a27db5322062a6fab0474ab14f2bc9a1bf47990be35.log`
under the isolated acceptance home's provider logs.

`apps/server/src/speech/operatorProtocol.ts` now classifies confirmed capacity
rejections by the structured overload code or the capacity/overload message.
`callOperator.ts` retries three times after 1, 2 and 4 seconds. Each retry keeps
the job's exact model, provider instance and effort, reuses its existing linked
session and uses a distinct attempt message ID. Changing the selector applies
to later work; it does not substitute a model during this retry sequence.
The typed `progress` update says "Retrying" and includes its delay and retry
count. Routine progress remains available to the voice model when Jared asks.
After the fourth rejected turn, a `needs-Jared` result explains the capacity
failure. Quota, permission, transport and interrupted failures are not retried
as capacity errors. Provider-owned retries remain provider-owned.

The internal job schema adds optional retry count and retired turn IDs plus a
`retrying` phase. Older saved jobs remain readable. Claims are serialized;
retired/error-completed turns cannot finish a later retry or another job in
that session. Unverified done text is cleared before retrying. The existing
uncertain-delivery path remains for unconfirmed sends. The backoff belongs to
operator work and continues after hang-up. T3-process restart recovery retains
the previously documented limitations; no live restart was tested.

The generic "Background update ready." record remains internal server turn
input. `projectConversationThread` already removes its `voice-update:` user
message at all shared client-state boundaries. The web chat reads that state
through `useThreadDetail`; both snapshot/cache and streamed-update regressions
assert that the plain announcement and old raw prompts are absent while the
voice reply and activity remain. The parent screenshot was inspected; it does
not provide a full uncovered view of the thread. This patch changes no UI
filter or renderer, and does not claim a new live rendering measurement.

The helper was already counting the delivered message ID, so extra internal
turns could not increase that count. The live-6 report instead reached its
deadline while waiting for the successful operator result. The normal count
assignment follows that wait, while the report initialized it to false and
cleanup could overwrite it with false after unavailable readback. That false
was not evidence of a duplicate user message.

`scripts/otis-call-acceptance.mjs` now starts readback at delivery acknowledgment
and checkpoints it before the operator wait. `verifyCallDelivery` in
`scripts/lib/otis-call-evidence.mjs` counts only that delivery ID, preserves a
known count if cleanup readback fails and leaves unavailable counts null.
`deliveredMessageCount` and `chatMessageReadbackError` distinguish duplicates
from missing evidence. Operator completion timing now records a successful
attempt; failed attempts are counted separately and cannot carry an old typed
result into a later attempt.

Retain the single-caller `operatorCapacityFailure` classifier as the protocol
boundary and `retryOperator` as the backoff/queue boundary. `verifyCallDelivery`
is the readback evidence boundary; the `readDelivery` closure is reused at
delivery, final validation and cleanup. No new agent system, provider, model
catalog or wire status type was introduced.

Current receipts and full logs belong under
`.logs/otis-call/phase2-capacity-retry`. Exact commands and final source hashes
are in its final evidence manifest. The earlier sync-fixture failures remain
documented below; their tests were not changed. Parent acceptance should use
a fresh 375 px call with output `.logs/otis-call/phase2-capacity-retry-live`:
verify a real capacity rejection produces a retry status without immediate
needs-Jared, keeps the selected model, then speaks/hears the recovered result
or bounded exhaustion. Confirm `exactlyOneChatMessage: true` and no internal
announcement bubble. An unavailable readback must report null with its named
error.

Final offline checks passed 117 tests across four focused files and 22 helper
tests, exit 0. These cover capacity recovery and exhaustion, the pinned model
and effort, hang-up during backoff, duplicate/late failure receipts, clearing
an unverified old done claim, unrelated failures, shared-state announcement
filtering, delivery proof and deadline behavior. Server, client-runtime and
web typechecks passed, exit 0. Affected lint, source/Markdown formatting,
acceptance syntax and diff whitespace checks passed, exit 0. The two lint
warnings are unchanged schema compilation and Promise.all spread. No new live
provider run occurred. Exact command receipts are in
`.logs/otis-call/phase2-capacity-retry/final/check-results.json`.

Owner job `d78d0450-8f4e-4100-9ea8-515bbc54ab02` remained queued after the
ten-minute owner wait. Its readback position was 3, with no admission, logs or
exit code. The direct offline receipts above are separate; queued submission
is not passing evidence. No queue or unrelated job was changed. The manifest
`.logs/otis-call/phase2-capacity-retry/final-evidence.json` binds the current
owned sources to those receipts. Live retry recovery and the updated helper
report remain parent acceptance gates.

## Prior implementation and evidence

The parent accepted `75381552b7` in `.logs/otis-call/phase2-live-5/report.json`:
seven sentences played, the operator result was heard and hang-up acknowledged.
The report records Claude Haiku 5.5 with SDK effort medium and requests
GPT-6.1-Sol medium for the operator. It does not independently attest the
operator model or effort. These are parent-run results for the base revision.
The saved 390 px screenshot shows the remaining defect: an internal announcement
prompt and its JSON displayed as a user message.

This follow-up keeps that handoff out of the visible conversation. No live T3,
router or launcher changes, restarts or subagents were used. Changes remain
uncommitted. The parent owns publication and visual acceptance of this fix.

The parent then reported Jared's 19:24 CDT iPhone Safari observation over
Tailscale. The saved screenshot is
`A:/Dev/Artifacts/agent-packets/otis-call-20261018/jared-phone-panel-cutoff.png`.
Its call panel extends above the visible page. The model settings at the top
cannot be reached. The second fix is in the same uncommitted change set.
The parent's separate live provider/model visibility settings are untouched.

## Phone panel viewport follow-up

`apps/web/src/components/chat/ThreadVoiceControls.tsx` previously positioned
the panel absolutely above the composer and limited its height to `70dvh`.
That limit did not account for how little space remained above the composer;
ancestor clipping could also hide it. All content, including actions, used
one scroll container.

The panel now uses the existing `Popover` / `PopoverPopup`, anchored to the
same composer control. Its portal avoids ancestor clipping and its existing
collision positioning supplies `--available-height`. The content is bounded
by that space and `100dvh`, less safe-area insets and margin; width uses
`100dvw`. The status header and primary action footer do not shrink or scroll.
Only settings, errors, preparation steps and unheard updates scroll inside
the panel. Start, Send speech, Retry and End call keep the existing controller
callbacks. Opening the panel does not move keyboard focus.

No new production helper or generic popover behavior was added. Web and
Electron share this panel; native mobile still has no Otis Call controls.
The callback tests cover before-call, Listening and Call needs attention,
including portal placement outside the composer and separate action routing.
They do not measure CSS layout.

The ignored report folder `.logs/otis-call/phase2-phone-panel` contains the
isolated fixture and browser runner. It builds the actual controls, selectors,
popover and production stylesheet with synthetic call ports and a composer.
It makes no live T3, provider, microphone or router requests. The planned checks
use 375x560 and 390x600 visible viewports, before-call, Listening and attention,
top/bottom scroll screenshots, action clicks and a live shrink to 420 px high.
The installed WebKit cache requires an explicit executable path with the
current Playwright package; the runner records that choice. No browser was
downloaded.

Both WebKit and installed Edge failed at process launch with `spawn EPERM`.
Their complete attempts are retained in `browser-probe-3` and
`browser-probe-4`, with the final failure in `report.json`. No screenshot was
captured and no viewport case ran. The advertised tool metadata and selected
Otis capability catalog expose no browser control route. The implementation is
checkpointed; the requested screenshots and visual proof remain blocked on a
headless browser capability. No connected phone or desktop window was used.

Parent browser commands, after supplying a permitted headless browser launch:

```powershell
& 'A:/Dev/Tooling/t3-node-v24.19.0/node.exe' .logs/otis-call/phase2-phone-panel/browser-check.mjs
# If only the installed Chromium engine is available:
$env:CALL_PANEL_ENGINE = 'chromium'
& 'A:/Dev/Tooling/t3-node-v24.19.0/node.exe' .logs/otis-call/phase2-phone-panel/browser-check.mjs
```

That runner must pass before treating the panel layout as verified. Inspect
the generated `375-before-call.png`, `375-listening.png`,
`375-needs-attention.png` and corresponding `390-*.png`, plus their scrolled
versions. Then repeat the real Safari call with its toolbars visible, change
orientation, scroll back to Voice model, and activate the footer actions.
The local fixture cannot attest iPhone Safari chrome or the Tailscale path.

Final offline receipts are under `phase2-phone-panel/final`: 123 tests passed
across seven files, exit 0. Web and client-runtime typechecks, affected lint,
source and Markdown formatting and whitespace checks passed, exit 0. The
server source is unchanged from the prior passing server typecheck. Lint has
four warnings on unchanged schema compilation, iterable spread and effect
dependencies/state synchronization. Full logs are retained. The earlier
expanded sync-fixture failures are still documented below and were not hidden
by changing those tests.

Owner job `27b5e239-25a7-471c-8e6a-515bbc54abc5` remained queued at position 9
after its ten-minute owner wait, without admission, process logs or exit code.
The direct offline receipts use a separate output directory. The job and queue
were left intact. No deployment, restart, live configuration change or subagent
was used.

`phase2-phone-panel/final-evidence.json` binds both uncommitted fixes and their
documentation to source hashes. `phase2-phone-panel/report.json` is a failure
report with zero executed viewport cases, not successful screenshot evidence.
The bounded implementation remains checkpointed for an added browser
capability and the requested screenshots.

Claude supports tool-free voice. Other voice adapters still reject that mode.
The original requirement to use every provider for voice remains unmet.

## Internal handoff visibility

`CallOperator.announce` still starts an ordinary durable turn with its existing
`voice-update:` identity, but stores only "Background update ready." as its
message text. `CallOperator.voice` builds the detailed model input from the
saved updates matching that announcement ID. The model receives the same
result/question instructions, typed status, exact result text and recent
conversation. Later receipts stay outside that announcement's batch. Existing
turn mapping, heard acknowledgment and no-delegation behavior remain in place.

`packages/client-runtime/src/state/threadState.ts` projects the conversation
without user messages with the reserved announcement identity. `threads.ts`
applies it to disk and retained cache, snapshots, streamed updates and older
history pages, including old raw prompts already stored by earlier calls.
Ordinary user messages and assistant replies remain visible. The existing
natural-language `call.operator.status` activity supplies the small background
status row; no second row or chat is added.

Web, Electron and the native thread feed all read this shared thread state.
Server event history and provider routing retain their durable turn identity.
There is no wire schema, permission, selector or provider adapter change and no
new helper with one caller. Retain `projectConversationThread` as the shared
projection at those cache and stream boundaries. The source and tests establish view behavior;
this change has not been checked in a running browser or a real call here.

Parent acceptance: reuse the commands below on a fresh chat with output
`.logs/otis-call/phase2-private-handoff-live`. At 390 px, verify no user bubble
contains the internal instruction, JSON or "Background update ready." The
background activity and natural voice reply should remain visible. Confirm
`operator.heard`, playback drain and hang-up acknowledgment. Reload the existing
live-5 chat to check that its old internal prompt also disappears.

## Offline verification of handoff visibility

Receipts and full logs are in `.logs/otis-call/phase2-private-handoff-final`.
The final focused owner selection passed 118 tests in five files, exit 0;
its exact command and summary are under `owned/check-results.json` and
`owned/focused-owned.log`. It covers `callOperator.test.ts`,
`threads-atoms.test.ts`, `threads-pagination.test.ts`, `threadReducer.test.ts`
and `apps/web/src/voice/session.test.ts`.
The six-file expanded run finished with 137 passing tests and five timeouts in
the unchanged `threads-sync.test.ts`. All new handoff, snapshot/cache, live
update and older-page regressions passed, as did the existing playback,
hang-up, heard acknowledgment, reducer and pagination checks.

Server, client-runtime and web typechecks passed, exit 0. Affected source lint
and formatting passed, exit 0. The lint warnings refer to unchanged schema
compilation in the fixture and an existing Promise.all spread.

The five sync fixtures load cached sequence 7, then send snapshots/events at
sequence 1 or 2. The existing dedupe rule correctly ignores them; the tests
wait for states those events cannot produce. No fixture contract was changed
to hide these failures. A separate baseline probe and its exact command are
recorded in `baseline-sync-probe.json` and `baseline-sync-probe.log`.
That probe reproduced the first timeout against the untouched `75381552b7`
thread implementation, exit 1, with 23 unrelated tests skipped. The other four
timeouts share the stale fixture sequence pattern by source inspection; they
were not separately reproduced against the base. The sync fixture repair
remains outside this change.
The new synthetic regressions do not prove browser rendering or real speech.

To repeat the focused selection:

```powershell
& 'A:/Dev/Tooling/t3-node-v24.19.0/node.exe' node_modules/vite-plus/bin/vp test run apps/server/src/speech/callOperator.test.ts packages/client-runtime/src/state/threads-atoms.test.ts packages/client-runtime/src/state/threads-pagination.test.ts packages/client-runtime/src/state/threadReducer.test.ts apps/web/src/voice/session.test.ts --configLoader native --pool threads --maxWorkers 1 --cache=false --reporter dot
```

Owner job `acd8b6d5-422a-4b9d-b9f4-515bbc54abcd` remained queued at position 8
after the ten-minute owner wait, without admission, process logs or an exit
code. Separate direct offline checks supplied the receipts above. The queue
and unrelated jobs were not changed. Queue submission is not passing evidence.

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
a pause. Interrupted results stay unheard. The voice can hold silently; timed
deferral remains future scope.

## Previous live-3 measurements

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

## Confirmed empty-text cause and correction

Parent live acceptance of `bd62911144` used chat
`6d3d0595-4289-4df2-a509-7e6eb7623bd8`. Evidence is
`.logs/otis-call/phase2-live-4/report.json` and its `phone-call.png`.
Failure capture now works. Sentence 1 played, sentence 2 had zero fetch attempts,
and the call reported invalid audio frames. The parent read the exact voice
reply through `agent snapshot` and verified that it ended with two newlines.

The sentence extractor queued the trailing whitespace. `speak()` removed
markdown markers and passed the empty fragment to `call.speak`.
`encode(input.request)` ran inside the fetch try block; `ValidCallRequest`
rejected the text with "Speech requires an ID and text." That local SchemaError
was mislabeled as invalid audio frames, and previously as an endpoint fetch
failure. The local encoding error explains both runs without an HTTP request
for sentence 2. The earlier report lacked that local failure classification.

`packages/client-runtime/src/voice-call/session.ts` now cleans markdown before
queueing and skips fragments whose cleaned text is whitespace-only. It advances
their offsets as handled once no earlier speech from that message remains
queued. This preserves playback ordering and allows the whole reply to count as
handled for heard acknowledgment. Silent fragments produce no sentence event,
synthesis or played request. Nonempty speech keeps its original message ranges.

`packages/client-runtime/src/voice-call/transport.ts` now encodes the request
before entering the authenticated fetch/response error boundary. A failure is
labeled "Local voice request validation failed. This is a client bug." It is
not mislabeled as network or response data and does not invoke fetch. The queue
filter prevents these silent fragments from reaching that validation at all.
No new helper, wire contract or provider behavior was introduced.

Existing request retries, independent acknowledgment retries, partial-audio
cancellation and failure screenshot capture remain in place. Their prior
synthetic checks and history are under `.logs/otis-call/phase2-recovery-direct`.

## Offline verification of the empty-speech fix

Current focused check receipts and logs are under
`.logs/otis-call/phase2-empty-speech-direct`. The exact commands are in
`check-results-current.json` and source hashes are in `final-evidence.json`.
The focused run passed 47 tests across two files, exit 0. Client-runtime and
web typechecks passed, exit 0. Affected lint, formatting and diff whitespace
checks passed, exit 0. No live browser or speech run was performed here. New regressions use a valid first sentence followed by two newlines or
a markdown-only fragment. Each must synthesize only the first sentence, leave
its offset unadvanced while playback is pending, persist the complete handled
offset afterward and acknowledge the operator update without an error.
The transport regression sends an invalid whitespace-only request directly and
verifies that fetch is never called and the error is explicitly local.

The focused owner command covers `apps/web/src/voice/session.test.ts` and
`packages/client-runtime/src/voice-call/transport.test.ts`, followed by
client-runtime and web typechecks. No server or contract schema changed.
Affected lint, formatting and whitespace checks apply as well.

Owner queue job `bbd4ead5-0a13-4545-aaeb-1f81a3e86b36` returned still-running
after ten minutes. The subsequent receipt remained queued at position 21, with
no admission, process logs or exit code. Direct checks use a separate output
directory. Queue submission is not passing evidence. The parent's subsequent
live-5 run accepted the empty-speech fix, with seven sentences played and
`operator.heard: true`. Visual acceptance of the handoff visibility fix remains.

## Previous recovery verification

Previous recovery receipts and logs are under `.logs/otis-call/phase2-recovery-direct`.
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
& $callNode @callArgs --output .logs/otis-call/phase2-private-handoff-live
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
The overall task still has generic tool-free voice support and integrated owner
checks outstanding. The default provider pair passed the parent's live-5 call.
This follow-up still needs the visual acceptance described above.
Previous empty-speech evidence is
`.logs/otis-call/phase2-empty-speech-direct/final-evidence.json`.
Previous recovery evidence is
`.logs/otis-call/phase2-recovery-direct/final-evidence.json`.
Earlier phase 2 and lease-fix receipts remain under `.logs/otis-call/phase2`
and `.logs/otis-call/phase2-fixes-direct`.

Retain `runAcceptanceWithDeadline` as the report and
process deadline boundary. Inlining it would tie its hung-cleanup tests to real
providers and a browser. The local `checkpoint` closure is intentionally shared
by initial, pre-cleanup and failure writes. `hasUnannouncedUpdates` has multiple
callers and keeps one terminal-status eligibility rule. No new agent system,
model catalog, transport or UI entry point was added.

Retain the single-caller `playSentence` helper as the audio-attempt boundary;
it keeps cancellation and partial-stream retry out of queue management.
`retry` is shared by request and synthesis operations. The shared `errors.ts`
module keeps retry classification shared with transport error construction.
`captureFailure` is shared by normal failure cleanup and the outer deadline
supervisor. None should be inlined into UI rendering or provider orchestration.

Retain the single-caller `voiceRequestError` normalizer as the environment HTTP
adapter boundary. It unwraps the known fetch-error wrappers to preserve a speech
error's retry policy. Inlining it into the transport generator would mix wrapper
handling with streamed PCM parsing.
