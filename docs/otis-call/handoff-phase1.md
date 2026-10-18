# Otis Call phase 1 handoff

Task `agenda-task:515bbc54cb61482681e950e524421ce4`.
Branch `work/otis-call-20261018`, baseline HEAD `d96f549d66`, upstream
`origin/work/otis-call-20261018`. Changes are uncommitted, as requested.
Observation date: 18 October 2026, America/Chicago, CDT. Exact check times and
commands for this revision are in ignored `.logs/otis-call/speech-reply-fixes` evidence.
The host did not expose independent runtime model and reasoning-effort
attestation. No subagents were used.

## Evidence rungs

| Rung                    | State                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Built                   | Reply capture/playback gating and independent acceptance reporting repaired in source. No distributable server/web bundle was produced here.                                                     |
| Tested offline          | Focused behavior, auth and contract tests; real T3 engine/SQLite delivery recovery with synthetic speech; acceptance parser/watcher tests. Exact final counts and exits follow below.            |
| Needs parent acceptance | Repeat real spoken reply and helper acceptance on this candidate. Parent already observed phone controls, transcription, one message, Haiku 5.5 medium and completed Otis tools at the baseline. |
| Committed/pushed        | These changes are neither committed nor pushed. The baseline was already pushed. Parent publication is required.                                                                                 |
| Not deployed            | No live T3 restart, deployment, router restart, engine download or Otis-side change occurred.                                                                                                    |

The voice gate and Claude hook are deleted. Calls use ordinary T3 turns and the
thread's existing permissions. Hang-up does not send an interrupt. The normal
model selector supplies each recording's model/options, which stay attached to
that recording across retries. No separate call model field remains.

Raw-save ordering, upload identity, closed outbox drain, thread-binding repair,
validated archive reads/writes, persisted dispatch commands and bounded status
are implemented. Deferred engine tests cover renewal, interrupt and close during
STT/TTS, late acquisition and failed health. The controller separates detach,
retry and hang-up, journals capture locally, cancels the ready cue, and silences
late output from interrupted turns. Environment transport reuses cookie, desktop
bearer and refreshed DPoP authorization.

## Spoken reply and evidence follow-up

The parent committed the preceding fixes as `d96f549d66`. Its isolated 390 px
run reached first text, but scheduled no reply audio. The retained report is
`.logs/otis-call/medium-baseline/report.json`. The source and offline evidence
for this follow-up are separate from that real run.

- `packages/client-runtime/src/voice-call/session.ts` reproduced a playback
  gate: an active microphone capture keeps a queued assistant sentence from
  reaching `call.speak`. New replies now finish microphone capture, retain its
  raw bytes on PC, and play the reply. Retained input waits until playback and
  the current turn finish before normal transcription/delivery. Streaming
  sentences and completed replies have regression coverage. JSON/code filtering
  stays in place; the reproduced failure is queue/capture state, not that filter.
- `apps/web/src/components/chat/ChatComposer.tsx` also uses the durable latest
  turn's running state when supplying call state. Provider session startup and
  approval transitions must not falsely tell voice that chat work is idle.
- `scripts/lib/otis-call-evidence.mjs` matches Claude's actual canonical
  `item.completed` receipt with `itemType=mcp_tool_call`, `status=completed`
  and exact `data.toolName=mcp__otis__get_task` for `--expect-tool get_task`.
  Failed calls, other tools, other servers and generic tool titles do not count.
- `scripts/otis-call-acceptance.mjs` verifies raw PCM immediately after upload
  acknowledgment. Provider completion is collected independently after a voice
  failure; the final drain reads appended receipts before closing the watcher.
  Timings derive from stage stamps on every update and in finalization. Alert
  text, call state and its transitions, error kind/detail, failed voice action/status and a screenshot
  are retained on failure. A screenshot is taken before attempting hang-up.

The original suffix matcher already accepts the retained successful receipt.
The old report stopped before completion and did not preserve enough failure
context to assign the missing receipt to a matcher defect. The new matcher is
stricter and tested against the observed event shape. The completed `get_task`
receipt is at 5:36:08.562 AM CDT and turn completion at 5:36:12.647 AM CDT.
The call's router activity in the requested interval contains acquisition,
transcription and renewal, with no TTS request.

The original alert is unknown. No screenshot or alert text survived that run;
its generic `Acceptance stopped` error does not prove an alert appeared.
The source-reproduced capture gate explains a way to suppress `call.speak`,
but the exact old browser state cannot be recovered. A live rerun must confirm
that this was the remaining speech failure. No live UI or router probe ran here.

The actual raw layout already matches the helper:
`userdata/voice/calls/<callId>/<utteranceId>.raw.json` and adjacent `.pcm`.
The false raw flag came from running verification only after all audio/provider
checks. An offline read of the retained archive verifies 1,024,000 PCM bytes and
the metadata hash. The audit is local at
`.logs/otis-call/speech-reply-fixes/parent-evidence-audit.json`; it contains no
transcript, tool arguments or audio payload.

Recovered timing from the parent's recorded stages:

| Interval                            | Measured milliseconds |
| ----------------------------------- | --------------------: |
| Speech end to upload acknowledgment |                   140 |
| Speech end to transcript            |                  8710 |
| Transcript to delivery              |                   135 |
| Delivery to first text              |                 69465 |
| Speech end to first text            |                 78310 |
| First text to first audio           |                  null |

These are one parent-run sample, not a performance recommendation. Whisper is
unchanged. New timing fields include `speechEndToTranscript`,
`transcriptToDelivery`, `deliveryToFirstText` and `firstTextToFirstAudio`.
Existing cumulative fields remain elapsed from `stages.speechEnded`. A failed
run keeps known measurements and leaves genuinely missing observations null.

## Offline checks

Use Node `A:/Dev/Tooling/t3-node-v24.19.0/node.exe`. Set PATH so Vite+ child
processes use that Node too. Package scripts own `tsgo --noEmit`; run packages
sequentially using the previously authorized direct fallback for the queue's
4 GiB memory cap.

```powershell
$env:PATH = 'A:/Dev/Tooling/t3-node-v24.19.0;' + $env:PATH
$env:GOMAXPROCS = '2'
$callTsgo = (Get-ChildItem 'node_modules/.pnpm/@typescript+native-preview-win32-x64*/node_modules/@typescript/native-preview-win32-x64/lib/tsgo.exe').FullName
& $callTsgo --noEmit -p packages/contracts/tsconfig.json
& $callTsgo --noEmit -p packages/client-runtime/tsconfig.json
& $callTsgo --noEmit -p apps/web/tsconfig.json
& $callTsgo --noEmit -p apps/server/tsconfig.json

node node_modules/vite-plus/bin/vp test run apps/server/src/speech/proxy.test.ts apps/server/src/speech/callService.test.ts apps/web/src/voice/session.test.ts apps/web/src/components/chat/ChatComposerVoice.test.tsx packages/client-runtime/src/voice-call/transport.test.ts packages/client-runtime/src/state/environmentHttpAuth.test.ts packages/contracts/src/speech.test.ts --configLoader native --pool threads --maxWorkers 1 --reporter dot
node node_modules/vite-plus/bin/vp test run apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts --testNamePattern 'delivers a saved voice' --configLoader native --pool threads --maxWorkers 1 --reporter dot
node --test --test-isolation=none --test-reporter spec scripts/lib/otis-call-evidence.test.mjs
node --check scripts/otis-call-acceptance.mjs
node scripts/otis-call-acceptance.mjs --help
git diff --check
```

Final checks on 18 October 2026, America/Chicago, CDT. Exact times are in the local receipts:

| Check                                                       | Exit and count                                  | Local evidence                                |
| ----------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| Contracts typecheck                                         | 0                                               | `typecheck-packages-contracts-final.log`      |
| Client-runtime typecheck                                    | 0                                               | `typecheck-packages-client-runtime-final.log` |
| Web typecheck                                               | 0                                               | `typecheck-apps-web-final.log`                |
| Server typecheck                                            | 0                                               | `typecheck-apps-server-final.log`             |
| Focused regressions, contracts, auth and composer lifecycle | 0; 100 passed in 7 files                        | `tests.log`                                   |
| Engine/SQLite delivery recovery                             | 0; 1 passed, 29 excluded by name filter         | `integration.log`                             |
| Acceptance WAV/parser and receipt watcher                   | 0; 6 passed                                     | `helper-tests.log`                            |
| Acceptance syntax and help                                  | 0 each                                          | `helper-syntax.log`, `helper-help.log`        |
| Affected source lint                                        | 0; no errors; 24 existing ChatComposer warnings | `lint-final.log`                              |
| Affected source format                                      | 0                                               | `format-check.log`                            |
| Two affected Markdown documents                             | 0                                               | `docs-check.log`                              |
| Diff whitespace                                             | 0                                               | `diff-check.log`                              |

The final test job is `45ff0b10-ea24-4ba8-9f55-af2fc1340044`, succeeded with
exit 0. Its command is the headless PowerShell launcher for the retained
`.logs/otis-call/speech-reply-fixes/tests.ps1`; that script sets the required Node
PATH and runs the exact test commands above. Typecheck commands and individual
exits are in `typecheck-results-final.json`. The launcher supplies the required Node PATH for Vite+ child processes.
The 4 GiB queue limit from the earlier phase remains the reason for direct,
sequential package typechecks. No unresolved queue receipt from this revision is
counted as success.

Exact affected lint and format commands, after loading the unchanged repository
configuration with `.logs/otis-call/gate-config.mjs`:

```powershell
$callSourceFiles = @(
  'packages/client-runtime/src/voice-call/session.ts',
  'apps/web/src/components/chat/ChatComposer.tsx', 'apps/web/src/voice/session.test.ts',
  'scripts/otis-call-acceptance.mjs', 'scripts/lib/otis-call-evidence.mjs',
  'scripts/lib/otis-call-evidence.test.mjs'
)
node .logs/otis-call/native-gates.mjs lint @callSourceFiles
node .logs/otis-call/native-gates.mjs fmt --check @callSourceFiles
$env:CALL_FORMAT_CHECK = '1'
node .logs/otis-call/format-markdown.mjs docs/otis-call/handoff-phase1.md docs/otis-call/architecture.md
Remove-Item Env:CALL_FORMAT_CHECK
```

The gate scope excludes the parent-owned server package edit. Remove the temporary `.otis-call-gates.config.mjs` after these checks.
The bundled Node fetch source records a 300000 ms headers default in
`node-fetch-deadline-source.log`, which is why acquisition uses Node HTTP.

Logs and exact command receipts are under `.logs/otis-call/speech-reply-fixes`.
Tests use synthetic speech and disposable storage. The integration case retains
real T3 engine, SQLite receipts, projections and restart, while substituting
speech and repository discovery. It proves one persisted message and turn,
not live provider execution. The composer lifecycle test checks source structure, not rendered viewport behavior.
Native HTTP acquisition has a mocked request-stream
test, not a live socket test. Timer tests simulate 600 seconds without waiting.

Stock Vite+ config bundling cannot spawn its loader in this sandbox. Focused
checks use its native config loader and thread workers. Lint and format use the
same installed Vite+ native runner with unchanged repository configuration via
`.logs/otis-call/native-gates.mjs`. Markdown uses installed Oxfmt's public
in-process API via `.logs/otis-call/format-markdown.mjs`. The temporary
import-free gate config is removed after verification. No production rule is weakened.

## Parent-run acceptance

Use the repository's `test-t3-app` skill. Start only an isolated dev instance:

```text
Executable: A:/Dev/Tooling/t3-node-v24.19.0/node.exe
Working directory: A:/Dev/Worktrees/t3-otis-call-20261018
Arguments: node_modules/vite-plus/bin/vp run dev --home-dir A:/Dev/Worktrees/t3-otis-call-20261018/.t3-call-acceptance
```

Use the owner's headless launcher with `CreateNoWindow=true` and
`UseShellExecute=false`, retain its captured PID, and redact pairing tokens before
writing output to disk. Read the actual web/server ports from `[dev-runner]`.
Do not set `VITE_HTTP_URL` or `VITE_WS_URL`, copy credentials, or open a connected
phone. Reuse existing provider authentication. Do not restart port 8085.
The speech tenants are installed according to the parent; runtime health has not
been checked here. No new Otis release dependency was introduced.

Create a fresh ordinary chat for every acceptance run. This executable packet
uses T3's existing authenticated agent actions, with fresh runtime identity:

```powershell
$callNode = 'A:/Dev/Tooling/t3-node-v24.19.0/node.exe'
$callRoot = 'A:/Dev/Worktrees/t3-otis-call-20261018'
$callHome = "$callRoot/.t3-call-acceptance"
Set-Location -LiteralPath $callRoot
& $callNode apps/server/src/bin.ts agent providers --base-dir $callHome
& $callNode apps/server/src/bin.ts agent capabilities --base-dir $callHome --command thread.create
$callSnapshot = & $callNode apps/server/src/bin.ts agent snapshot --base-dir $callHome | ConvertFrom-Json
$callProjectId = [guid]::NewGuid().ToString()
$callActionPath = "$callRoot/.logs/otis-call/create.json"
$callCreate = @{
  environmentId = $callSnapshot.environmentId
  runtime = $callSnapshot.runtime
  command = @{
    type = 'project.create'; commandId = [guid]::NewGuid().ToString()
    projectId = $callProjectId; title = 'Call acceptance'; workspaceRoot = $callRoot
    createdAt = [DateTime]::UtcNow.ToString('o')
  }
}
[IO.File]::WriteAllText($callActionPath, ($callCreate | ConvertTo-Json -Depth 20))
& $callNode apps/server/src/bin.ts agent act --base-dir $callHome --file $callActionPath --confirm
```

Require `status: accepted`. The project can be reused for later runs. Read the
actual provider instance ID from the provider output. A custom catalog entry
does not prove the provider can execute that model. This creates the chat only:

```powershell
$callInstance = 'REPLACE_WITH_OBSERVED_PROVIDER_INSTANCE_ID'
$callThreadId = [guid]::NewGuid().ToString()
$callSnapshot = & $callNode apps/server/src/bin.ts agent snapshot --base-dir $callHome | ConvertFrom-Json
$callCreate.runtime = $callSnapshot.runtime
$callCreate.command = @{
  type = 'thread.create'; commandId = [guid]::NewGuid().ToString()
  threadId = $callThreadId; projectId = $callProjectId; title = 'Call acceptance'
  modelSelection = @{ instanceId = $callInstance; model = 'claude-haiku-5-5'; options = @(@{ id = 'effort'; value = 'medium' }) }
  runtimeMode = 'approval-required'; interactionMode = 'default'; branch = $null; worktreePath = $null
  createdAt = [DateTime]::UtcNow.ToString('o')
}
[IO.File]::WriteAllText($callActionPath, ($callCreate | ConvertTo-Json -Depth 20))
& $callNode apps/server/src/bin.ts agent act --base-dir $callHome --file $callActionPath --confirm
```

Require `status: accepted`. Supply observed values below. The helper verifies
selection before forwarding `call.open`; it does not change a separate call model.
Use an existing Chromium installation and a local mono 16-bit PCM WAV, 8 to 96 kHz,
under 55 seconds, with at least a second of leading and trailing silence. The
recording should ask for one read-only Otis operation and a natural spoken
summary, for example `get_task` for this task. No real recording is supplied here.

```powershell
$callOrigin = 'http://localhost:REPLACE_WITH_OBSERVED_WEB_PORT'
$callThreadUrl = "$callOrigin/$($callSnapshot.environmentId)/$callThreadId"
$callWav = 'REPLACE_WITH_ABSOLUTE_LOCAL_WAV_PATH'
$callBrowser = 'REPLACE_WITH_INSTALLED_CHROMIUM_EXE'
$callArgs = @(
  'scripts/otis-call-acceptance.mjs', '--base-dir', $callHome, '--origin', $callOrigin,
  '--thread-url', $callThreadUrl, '--thread-id', $callThreadId,
  '--instance', $callInstance, '--model', 'claude-haiku-5-5', '--effort', 'medium',
  '--wav', $callWav, '--browser', $callBrowser, '--expect-tool', 'get_task'
)
& $callNode @callArgs --output .logs/otis-call/medium-baseline
```

The agent CLI creates approval-required threads only. Keep that mode. The helper
does not grant tool authority or auto-approve requests. During acceptance, answer
the expected read-only Otis tool in T3's ordinary approval panel. The call controls
stay mounted while that panel is open.

For a CLI response, use this in a second terminal after inspecting the pending
request. Re-run it for later expected requests. The set sends at most one response
per request ID in that terminal; keep the terminal open for the run. Do not answer
user-input requests with an approval response. The accepted decision applies to
one tool request, never the session.

```powershell
$callAnswered = [Collections.Generic.HashSet[string]]::new()
# Repeat this block when an expected read-only approval is waiting.
$callSnapshot = & $callNode apps/server/src/bin.ts agent snapshot --base-dir $callHome --thread $callThreadId | ConvertFrom-Json
$callPending = @($callSnapshot.thread.requests | Where-Object { $_.kind -eq 'approval.requested' -and -not $callAnswered.Contains($_.requestId) })
$callPending | Select-Object requestId, requestKind, detail | Format-List
# Inspect the displayed requests, then respond only to the expected acceptance tool.
foreach ($callRequest in $callPending) {
  $callAction = @{
    environmentId = $callSnapshot.environmentId; runtime = $callSnapshot.runtime
    command = @{
      type = 'thread.approval.respond'; commandId = [guid]::NewGuid().ToString()
      threadId = $callThreadId; requestId = $callRequest.requestId; decision = 'accept'
      createdAt = [DateTime]::UtcNow.ToString('o')
    }
  }
  $callApprovalPath = "$callRoot/.logs/otis-call/approval.json"
  [IO.File]::WriteAllText($callApprovalPath, ($callAction | ConvertTo-Json -Depth 20))
  [void]$callAnswered.Add($callRequest.requestId)
  & $callNode apps/server/src/bin.ts agent act --base-dir $callHome --file $callApprovalPath --confirm
}
```

Require `status: accepted`. If a response fails, inspect current request evidence
before removing its ID from the set and retrying. Do not auto-approve unrelated
requests. No authentication material belongs in this packet or its output.

For each following command, create a fresh chat and update the thread ID/URL
inside `$callArgs`. Retain the same WAV and warmed engines:

```powershell
& $callNode @callArgs --disconnect-at upload --output .logs/otis-call/upload-recovery
& $callNode @callArgs --disconnect-at delivery --output .logs/otis-call/delivery-recovery
& $callNode @callArgs --disconnect-at speech --output .logs/otis-call/speech-recovery
& $callNode @callArgs --reload-after-save --output .logs/otis-call/reload-recovery
& $callNode @callArgs --hang-up-after-delivery --output .logs/otis-call/chat-after-hang-up
```

The helper uses a 390x844 headless browser by default. Repeat with `--width 375`. It uses a fake microphone supplied by the real
WAV, real speech engines, the real chat provider and a completed Otis tool. It
checks retained PCM bytes, SHA-256 and length, transcript/delivery agreement, and
exactly one message in full authenticated browser readback. Provider completion
comes from newly appended canonical event receipts in this isolated home's
per-thread provider log, not a delay or bounded CLI activity list.

Evidence stays under `.logs` as `report.json` and `phone-call.png`. Pairing tokens
remain in memory. Reports omit transcript text, tool arguments and audio. They
distinguish actual model observations, SDK-configured effort and provider-attested
effort. Missing provider effort attestation stays null. A passing helper means
`passed-observations-needs-parent-acceptance`, not full product acceptance.
The parent must inspect screenshots, listen to speech, verify audible interruption,
and resolve absent provider attestation. Scheduled playback is not acoustic onset.

An early-hang-up run requires the provider's own completion timestamp to follow
the close acknowledgment. If the read finished sooner, repeat with a longer
read-only operation. The helper never requires a stopped chat after hang-up.

The earlier phone, cold-start and cross-device gates still apply. For this revision, first rerun the fresh-chat helper and verify a successful named Otis tool, audible natural reply and populated raw/timing fields. Then verify the failure report on a disposable synthetic speech failure, including its alert or explicit absence. No simulated failure against the router is authorized here. Remaining parent acceptance gates:

1. Run the helper with `--width 375` and `--width 390` on fresh chats.
   Check the collapsed composer, model picker, call state, interruption and End.
   Answer an ordinary tool approval and verify the call remains attached.
2. Start with engines cold through the existing router owner's setup. Check the
   progress text, successful preparation beyond 90 seconds, and no early timeout.
   In a separate run, end during preparation and confirm a later router grant is
   released. This implementation does not restart or reconfigure the router.
3. End a call, then use another browser on that same chat to start a new call,
   including while the chat still has a tool approval pending. Confirm a new
   call ID and router preparation. The fresh-chat helper intentionally refuses
   used chats, so this cross-device follow-up is a manual parent check.
4. Confirm one stderr line for each stage reached. Normal completion reaches
   every stage. An early-hang-up run can omit first audio; missing measurements
   remain null. Verify ordinary approval-required execution and the completed
   expected Otis tool in the report.

Still required outside this sandbox: disposable server-process restart/reconnect,
provider cloud disconnection, phone suspension/process loss, Electron bearer auth,
HTTPS remote and real relay transport. Do not perform these against daily-use T3.
The parent should restart only its captured isolated process through its owner
launcher, preserving the isolated home, then resume the same call/outbox. No live
release or router restart is part of this acceptance helper.

Repeat baseline with supported low/default effort and fresh chats. Keep raw
samples and sample counts, then compare medians. Every live latency and thinking
overhead measurement from this implementation chat is null. There is no measured
recommendation to replace Jared's medium starting point.

## Remaining scope and publication

Web and desktop share these browser controls. Cookie/bearer/relay auth has offline coverage. Model-selection validation covers five driver names; those fixtures do not establish live provider compatibility or client acceptance. Calls use only existing chats; there is no separate Settings/palette
entry or hidden voice authority. End, resume and explicit interrupt are present.
Native mobile retains its old draft dictation. Native calls remain an unfulfilled
surface requirement for the parent to resolve; the phone browser is implemented.

Retain the new single-caller `verifyCallRaw` and `completedOtisTool` as archive-verification and provider-receipt boundaries. Their focused fixture tests guard those external formats. `callTimings` is shared by live updates and finalization. Earlier single-caller helpers remain intentional boundaries. The preceding fix introduced `acquireSpeechLease`, which owns the Node HTTP cold-start transport and `unbind` owns guarded thread-index cleanup. Inlining either would mix transport or storage lifecycle into its caller. `newCall` has two callers and shares fresh-call initialization. Earlier boundaries remain: `activeCall` owns
binding recovery; `speechIdentifier` owns bounded replay identity; `startRenewal`
owns the renewal fiber; `fetchEnvironmentSpeech` and `createVoiceRequestCommand`
own environment auth adaptation; `validatePcmWav` and `watchCallReceipts` own CLI
preflight and receipt parsing; `spokenMessageText` owns speech sanitization behind
the per-message cache. Their behavior crosses storage, lifecycle or
transport seams. Inlining would mix those responsibilities into their callers.

Parent review should compare this dirty candidate with `d96f549d66`, include new
source/test files. Preserve the parent-owned `apps/server/package.json` no-watch edit and exclude it from this commit. Exclude `.logs`, recordings, the isolated home and temporary
gate configuration, and use `COMMIT_MSG.txt`. Git metadata is outside this
sandbox's write authority, so no commit or push was attempted.
The live T3 owner must provide exact build/install/release and rollback commands
after acceptance. Those commands were not established here. Do not substitute a
guessed production restart. Keep port 8085 untouched.
