# Otis Call phase 1 handoff

Task `agenda-task:515bbc54cb61482681e950e524421ce4`.
Branch `work/otis-call-20261018`, unchanged HEAD `5a791b842b`, upstream
`origin/work/otis-call-20261018`. Changes are uncommitted, as requested.
Observation date: 18 October 2026, America/Chicago, CDT. Exact check times and
commands are in ignored `.logs/otis-call` evidence.
The brief assigns GPT-6.1-Sol at high reasoning. The host did not expose an
independent runtime model/effort attestation. No subagents were used.

## Evidence rungs

| Rung                    | State                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built                   | Source implementation and four package typechecks complete. No distributable server/web bundle was produced here.                                                                                    |
| Tested offline          | Focused behavior, auth and contract tests; real T3 engine/SQLite delivery recovery with synthetic speech; acceptance parser/watcher tests. Exact final counts and exits follow below.                |
| Needs parent acceptance | Real Whisper/Breeze audio, actual selected cloud model, Otis tool execution, provider effort attestation, screenshots, audible interruption, desktop and remote/relay workflows, latency comparison. |
| Committed/pushed        | These changes are neither committed nor pushed. The baseline was already pushed. Parent publication is required.                                                                                     |
| Not deployed            | No live T3 restart, deployment, router restart, engine download or Otis-side change occurred.                                                                                                        |

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

## Offline checks

Use Node `A:/Dev/Tooling/t3-node-v24.19.0/node.exe`. The owner package scripts are
`tsgo --noEmit`. Direct package checks use the installed native executable below,
one package at a time, with `GOMAXPROCS=2`:

```powershell
$env:PATH = 'A:/Dev/Tooling/t3-node-v24.19.0;' + $env:PATH
$env:GOMAXPROCS = '2'
$callTsgo = (Get-ChildItem 'node_modules/.pnpm/@typescript+native-preview-win32-x64*/node_modules/@typescript/native-preview-win32-x64/lib/tsgo.exe').FullName
& $callTsgo --noEmit -p packages/contracts/tsconfig.json
& $callTsgo --noEmit -p packages/client-runtime/tsconfig.json
& $callTsgo --noEmit -p apps/web/tsconfig.json
& $callTsgo --noEmit -p apps/server/tsconfig.json
```

The owner queue typecheck job `7357c936-e232-4782-b934-1fa6d35dcc53` reproduced
the native VirtualAlloc failure at its 4 GiB cap. Its waiter returned
`still-running`, with no terminal exit code. The status operation through
`call_tool` was rejected by this host's never-approval policy. The direct fallback
was authorized in the brief. The parent must reconcile that queued job; this chat
did not kill an unverified PID. Its private logs are under
`C:/Users/PrecisionX/AppData/Local/Otis/build-jobs/logs/7357c936-e232-4782-b934-1fa6d35dcc53/`.

Stock `vp` config bundling also hit sandbox `spawn EPERM`. Focused tests use the
supported native config loader and thread workers. Formatting/linting used the
same Vite+ native runner and unchanged repository rules, loaded without config
bundling. The exact local adapter is `.logs/otis-call/native-gates.mjs`; it loads
`vite.config.ts` directly and points the format/lint loader to an import-free copy
of that configuration. No compiler settings or lint rules were weakened.

```powershell
node node_modules/vite-plus/bin/vp test run `
  apps/server/src/speech/proxy.test.ts `
  apps/server/src/speech/callService.test.ts `
  apps/web/src/voice/session.test.ts `
  packages/client-runtime/src/voice-call/transport.test.ts `
  packages/client-runtime/src/state/environmentHttpAuth.test.ts `
  packages/contracts/src/speech.test.ts `
  --configLoader native --pool threads --maxWorkers 1 --reporter dot

node node_modules/vite-plus/bin/vp test run `
  apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts `
  --testNamePattern 'delivers a saved voice' `
  --configLoader native --pool threads --maxWorkers 1 --reporter dot

node --test --test-isolation=none --test-reporter spec scripts/lib/otis-call-evidence.test.mjs
node --check scripts/otis-call-acceptance.mjs
node scripts/otis-call-acceptance.mjs --help
git diff --check
```

Final candidate checks on 18 October, 3:44 to 4:00 AM CDT:

| Check                                                 | Exit and count                                              | Local evidence                                             |
| ----------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| Contracts, client-runtime, web, server typechecks     | 0 for each package                                          | `final-typecheck-results.json`, `typecheck-*-final.log`    |
| Focused behavior, auth and contracts                  | 0; 89 passed in 6 files                                     | `tests-final.log`                                          |
| Real engine/SQLite recovery                           | 0; 1 passed, 29 unrelated cases excluded by the name filter | `delivery-integration-final.log`                           |
| Acceptance WAV/parser and receipt watcher             | 0; 3 passed                                                 | `acceptance-unit-final.log`                                |
| Acceptance syntax and help                            | 0 for each                                                  | `acceptance-syntax-final.log`, `acceptance-help-final.log` |
| Affected source lint                                  | 0; no errors                                                | `lint-final.log`                                           |
| Affected source format                                | 0                                                           | `format-final.log`                                         |
| Four affected Markdown documents, installed Oxfmt API | 0, including a final check without writes                   | `format-docs-api.log`, `format-docs-check.log`             |
| Diff whitespace                                       | 0                                                           | `diff-check-final.log`                                     |

All paths above are relative to `.logs/otis-call`. The final narrow cache/helper
cleanup was rechecked separately in `cleanup-*.log`. Full logs remain local;
they contain synthetic fixtures, not a live call. The integration test substitutes
speech and repository discovery while retaining the real engine, SQLite command
receipts, projections and restart. It proves one persisted message and one turn,
not cloud-provider execution. The selected integration case skips the other 29
cases in that owner file. Lint warnings in unchanged portions of ChatComposer and
MessagesTimeline and the decider are separate from errors. The final lint scope
has 34 such warnings. The changed voice modules and acceptance helper have none.

The Markdown CLI's worker spawn was denied by the sandbox. The fallback used
Oxfmt's public in-process `format()` API with the same effective Markdown options,
then compared the formatted output with disk. The exact adapter is
`.logs/otis-call/format-markdown.mjs`. Source lint/format use the repository's
unchanged configuration. Temporary root gate configuration was removed afterward.

Queued stock formatting job `803220a4-ff12-4870-984b-16224db379b7` also has no
terminal receipt. Its owner waiter returned `still-running` on 18 October at
about 3:56 AM CDT. Direct `get_build_job` then confirmed formatting queued at
position 2 and the typecheck still marked running. Both exits are null. The direct
status tool works; the earlier `call_tool` status rejection does not mean status
is inaccessible. The parent must reconcile both jobs before publication.
WMI denied command-line inspection for captured typecheck PID 63348. It was not
terminated. The discovered build-job catalog has submit/get/wait and no owner
cancellation operation. That cleanup capability is missing. No queued job is
counted as a passing gate.

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
  runtimeMode = 'full-access'; interactionMode = 'default'; branch = $null; worktreePath = $null
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

For each following command, create a fresh chat and update the thread ID/URL
inside `$callArgs`. Retain the same WAV and warmed engines:

```powershell
& $callNode @callArgs --disconnect-at upload --output .logs/otis-call/upload-recovery
& $callNode @callArgs --disconnect-at delivery --output .logs/otis-call/delivery-recovery
& $callNode @callArgs --disconnect-at speech --output .logs/otis-call/speech-recovery
& $callNode @callArgs --reload-after-save --output .logs/otis-call/reload-recovery
& $callNode @callArgs --hang-up-after-delivery --output .logs/otis-call/chat-after-hang-up
```

The helper uses a 390x844 headless browser, a fake microphone supplied by the real
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

Retain the new single-caller helpers as intentional boundaries: `activeCall` owns
binding recovery; `speechIdentifier` owns bounded replay identity; `startRenewal`
owns the renewal fiber; `fetchEnvironmentSpeech` and `createVoiceRequestCommand`
own environment auth adaptation; `validatePcmWav` and `watchCallReceipts` own CLI
preflight and receipt parsing; `spokenMessageText` owns speech sanitization behind
the per-message cache. Their behavior crosses storage, lifecycle or
transport seams. Inlining would mix those responsibilities into their callers.

Parent review should compare this dirty candidate with `5a791b842b`, include new
source/test files, exclude `.logs`, recordings, the isolated home and temporary
gate configuration, and use `COMMIT_MSG.txt`. Git metadata is outside this
sandbox's write authority, so no commit or push was attempted.
The live T3 owner must provide exact build/install/release and rollback commands
after acceptance. Those commands were not established here. Do not substitute a
guessed production restart. Keep port 8085 untouched.
