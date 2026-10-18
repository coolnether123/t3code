# Otis Call phase 2 handoff

Task `agenda-task:515bbc54cb61482681e950e524421ce4`.
Base `6f18caa404`, branch `work/otis-call-20261018`, upstream
`origin/work/otis-call-20261018`. Changes remain uncommitted as requested.
Observation date: 18 October 2026, America/Chicago, CDT.

This is a candidate, not an accepted live implementation. The default
voice/operator path is implemented. The requirement to use every provider for
voice is not met: Claude exposes tool-free sessions; other adapters reject that
mode. All configured providers remain selectable for the operator. No live T3
or router was changed or restarted. No subagents were used. Exact implementation
host model and effort attestation were unavailable and remain unknown.

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

## Measurements and offline checks

All live phase 2 timings are null. No live provider execution, audible onset,
phone rendering or operator latency was measured here. The parent's phase 1
measurements in `handoff-phase1.md` do not measure this candidate.

The helper reports `timingsMs.voiceAckLatency`, speech end to first scheduled
voice audio, and `timingsMs.operatorResult`, speech end to a successful operator
result receipt. Scheduled audio is not acoustic onset. Missing observations stay
null. Voice and operator evidence are separate. Reports omit transcripts, tool
arguments and credentials. Exact Otis MCP receipt matching covers Claude and Codex.

The final focused run started at 11:28 CDT:

| Check                                                     | Result                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Focused Vite+ suite                                       | Exit 0, 274 tests across 11 files.                                             |
| Acceptance evidence tests                                 | Exit 0, 12 tests.                                                              |
| Contracts, client-runtime, web and server `tsgo --noEmit` | Exit 0 for all four packages.                                                  |
| Affected lint                                             | Exit 0; existing composer effect warnings remain.                              |
| Affected format, acceptance syntax/help, diff whitespace  | Exit 0.                                                                        |
| Integrated ingestion probe                                | Exit 1 on both baseline and candidate, 1 failed and 49 skipped; `spawn EPERM`. |
| Live acceptance                                           | Not run. All latency measurements remain null.                                 |

Exact commands and exits are in `.logs/otis-call/phase2/check-results-final.json`.
The focused command covers `callOperator`, `callService`, `turnInput`,
`ClaudeAdapter`, `ProviderService`, the voice controller, model defaults, browser
speech, composer lifecycle, environment speech transport and speech schemas.
`final-focused.log` and `final-evidence.log` contain the counts. Tool-free mode
also survives harness recovery in the focused tests. The final source review
kept linked approval/input responses on the ordinary error-reporting path;
its server typecheck is `server-current-candidate.log`.

An exploratory broad run overlapped edits and is not candidate evidence. It
reported 111 failures and 273 passes. The fresh focused run above resolves its
feature fixture failures. The integration suites remain unpassed. The same
ingestion test was rerun with untouched baseline layer source through an isolated
loader, then with current source; both fail with `spawn EPERM`. See
`baseline-probe-final.log` and `current-ingestion-probe.log`. Parent rerun:

```powershell
& $callNode node_modules/vite-plus/bin/vp test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts --configLoader native --pool threads --maxWorkers 1 --reporter dot
```

Ignored logs are in `.logs/otis-call/phase2`. The first queued compiler exhausted its memory allowance;
the bounded-parallelism queue retry failed too. The documented direct fallback
uses `GOMAXPROCS=2`. Test job `f1806488-ad55-45f6-a2c5-20cf5818e5b3`
eventually returned exit 1: the temporary PowerShell launcher's Stop preference
treated Vite's stderr notice as a fatal error. It supplied no test result.
An earlier queued test also used an older child Node. Direct checks put the
repository's Node 24 first on PATH. A Node-based owner launcher now submits the
two integration suites as job `e543a158-d160-46d4-801b-bba96adb619a`.
Its result is recorded separately; queue submission alone is not verification.

At 12:08 CDT, that owner job reported `blocked`, FIFO position 13,
`reason: waiting-for-earlier-command`, with no admission, process log or exit
receipt. Three ten-minute `wait_for_build_job` calls returned `still-running`.
The immediate Otis read exposed the blocked state. The build-jobs capability
advertises `get_build_job`, but invoking it through `call_tool` returned
`MCP tool call requires approval, but approval policy is never`.
The catalog exposes submit, get and wait only, with no reconciliation operation.
The parent needs a directly exposed detail tool or an owner reconciliation route
before this integration gate can finish. No queue state, unrelated job, service
or permission policy was changed to bypass the blocker.

The broad orchestration tests encounter `spawn EPERM` when
`RepositoryIdentityResolver.resolveCacheKey` tries to spawn Git inside this
sandbox. Keep that host limitation separate from feature fixtures and live
integration. Existing test contracts were not weakened for it. Controller tests
changed where they formerly required immediate microphone cutoff; they now prove
that queued audio waits for a pause.

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
  '--width', '390'
)
& $callNode @callArgs --output .logs/otis-call/phase2-live
```

The helper saves the exact pair through the authenticated route, reloads the real
controls, follows both linked logs and waits for operator completion. Answer only
the expected approval in the ordinary T3 panel; nothing is auto-approved. Repeat
on fresh chats with `--width 375` and `--hang-up-after-delivery`, each with a new
output directory. Early hang-up must precede the operator completion receipt.
Normal split runs also wait for the result's heard acknowledgment before closing.
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
normal ProviderService routing and needs live acceptance. Generic selection is
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
integrated owner checks and real call acceptance remain outstanding. The private
checkpoint manifest is `.logs/otis-call/phase2/final-source-manifest.json`.
