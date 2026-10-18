# Otis Call phase 1 handoff

Task: `agenda-task:515bbc54cb61482681e950e524421ce4`.
Branch: `work/otis-call-20261018`, baseline `a1ba32d476`, upstream
`origin/work/otis-call-20261018` in `coolnether123/t3code`.
Observed 18 October 2026, America/Chicago (CDT).

The architecture handoff is complete. The feature is not. Changes remain
uncommitted for the parent to review, commit and push. Jared moved the remaining
build to **GPT-6.1-Sol, high reasoning**; no subagents were launched. See
[architecture.md](architecture.md) for the design, file-by-file state, protocol,
failure cases and eight numbered continuation jobs with acceptance criteria.

## Corrections the next builder must apply

Task revision 5 points to
`A:/Dev/Artifacts/agent-packets/otis-call-20261018/jared-corrections-20261018.md`.
Jared's newer direction: ordinary harnesses and permissions, additional voice
confirmation off by default, natural speech rather than raw tool JSON, hang-up
leaves the chat working, and T3's normal model selector chooses the model.
The current code conflicts with those corrections. The parent decides whether
to retain the gate as an option. Do not implement the superseded proposal for a
separate voice worker authority policy.

Breeze TTS 2 and Whisper large-v3-turbo are installed according to the parent.
The architecture export has been read and dependencies are present. Those former
blockers are cleared. This sandbox still cannot perform live provider/router checks
or write Git metadata. No downloads, live service changes or router restart occurred.

## Evidence rungs

| Rung | Current evidence |
| --- | --- |
| Built | Partial source: file store, call protocol, shared controller, browser UI, router integration and optional Claude hook. No successful build or typecheck. |
| Tested | Four production-file Node syntax checks and acceptance-script syntax check exit 0. `git diff --check` exits 0 with no diagnostics. Zero application test cases executed. |
| Measured | Speech-end-to-transcript, first text, first audio and thinking overhead are all null. No real call. |
| Raw/recovery | 16 synthetic cases written but not run. No real raw-save proof or disconnect acceptance. |
| Client | No live UI, screenshots or screenshot inspection. Helper can capture a 390x844 image after repairs. Native mobile untouched. |
| Committed/pushed | Neither. Proposed message is [COMMIT_MSG.txt](COMMIT_MSG.txt). |
| Deployed | Nothing deployed. Daily-use T3 and port 8085 untouched. |

Exact offline results:

- Server typecheck job `31b764af-72fb-4f0c-b127-63ad354f6174` remains reported
  running, exit code **null**. stderr records Windows VirtualAlloc errno 1455 and
  fatal out-of-memory inside a native job configured with a 4 GiB commit limit.
  Two owner waits returned still-running. No passing typecheck or final source
  diagnostics resulted.
- Focused test job `711a4385-df7e-4b81-84e0-3c1fc8f568d5` is blocked at position 1,
  reason `waiting-for-working-directory-or-output-owner`, exit code **null**.
  The selected files declare 28 cases: 5 existing proxy, 16 new call-service,
  7 existing controller tests. **0 executed; pass/fail counts unavailable.**
  The controller tests still use the old API and need contract-aware migration.
- `node --check` exits **0** for `callStore.ts`, `callService.ts`, `callToolGate.ts`,
  `packages/client-runtime/src/voice-call/session.ts`, and
  `scripts/otis-call-acceptance.mjs`. Syntax only.
- `git diff --check` exits **0**, 0 diagnostic lines. Affected lint, format,
  web/contracts/client-runtime typechecks, build and runtime acceptance have not run.

Small-check logs: ignored `.logs/otis-call/syntax-results.json`, `syntax-0.log`
through `syntax-3.log`, `acceptance-syntax.log`, and `diff-check.log`.
Full typecheck logs:
`C:/Users/PrecisionX/AppData/Local/Otis/build-jobs/logs/31b764af-72fb-4f0c-b127-63ad354f6174/command/c80bcc48-a1f9-4ef8-82e0-60795d3eb698/`.
WMI command-line inspection was denied; no process was killed. The build owner
must reconcile the stuck job and release workspace ownership before rerunning.
Do not start duplicate gates around that lock.

## Remaining owner commands

Run from this worktree. Submit long commands through the Otis build-job owner,
keep full logs locally, and use its completion waiter. Executable for each:
`A:/Dev/Tooling/t3-node-v24.19.0/node.exe`.

```text
node_modules/vite-plus/bin/vp test run apps/server/src/speech/proxy.test.ts apps/server/src/speech/callService.test.ts apps/web/src/voice/session.test.ts --reporter=dot --maxWorkers=1
node_modules/vite-plus/bin/vp run --filter t3 typecheck
node_modules/vite-plus/bin/vp run --filter @t3tools/contracts typecheck
node_modules/vite-plus/bin/vp run --filter @t3tools/client-runtime typecheck
node_modules/vite-plus/bin/vp run --filter @t3tools/web typecheck
```

Include Sol's new lifecycle/provider integration tests. Run targeted `vp lint`
and `vp fmt --check` over changed source, then the owner server/web builds.
The old controller tests protect cancellation/history behavior. Adapt them to
retain audio while preventing post-stop submissions; do not delete their protections.

## Isolated acceptance outside the sandbox

Use `test-t3-app` and the headless dev owner launcher. Never target the daily-use
home or ports. The exact launch command is:

```text
Executable: A:/Dev/Tooling/t3-node-v24.19.0/node.exe
Working directory: A:/Dev/Worktrees/t3-otis-call-20261018
Arguments: node_modules/vite-plus/bin/vp run dev --home-dir A:/Dev/Worktrees/t3-otis-call-20261018/.t3-call-acceptance
```

The launcher must use `CreateNoWindow=true`, `UseShellExecute=false`, retain its
captured PID and write logs under `.logs/otis-call`. Read actual web/server ports
from `[dev-runner]`; do not assume ports or set `VITE_HTTP_URL` / `VITE_WS_URL`.
Use existing authenticated provider access and an installed browser. If router
tenant IDs differ, set only process-local dev overrides. Do not install engines,
restart 8085 or reconfigure live T3.

Inspect this environment and obtain the current thread-creation schema:

```powershell
$callNode = 'A:/Dev/Tooling/t3-node-v24.19.0/node.exe'
$callHome = 'A:/Dev/Worktrees/t3-otis-call-20261018/.t3-call-acceptance'
& $callNode apps/server/src/bin.ts agent providers --base-dir $callHome
& $callNode apps/server/src/bin.ts agent snapshot --base-dir $callHome
& $callNode apps/server/src/bin.ts agent capabilities --base-dir $callHome --command thread.create
```

Create a disposable chat through T3 or its supported agent action schema. Select
the intended provider, exact `claude-haiku-5-5`, and supported medium effort.
Verify actual model, applied effort and Otis inventory. A catalog entry alone is
insufficient. Retain this dev chat's exact ID and URL. Never copy credentials into Git.

Prepare a local PCM WAV requesting a read-only Otis operation. For example, name
the task in the recording and ask Otis to read it and summarize its status in one
sentence. Pass `get_task` as the expected tool. Keep that WAV outside Git and reuse
it for comparison runs. No recording is supplied or represented as Jared's voice.

The helper is an **unrun acceptance candidate**. Fix its documented limitations
before making it a complete gate. Replace the values below with observed dev
values, then submit these long commands through the owner job route:

```powershell
$callOrigin = 'http://localhost:REPLACE_WITH_DEV_WEB_PORT'
$callThreadUrl = 'REPLACE_WITH_FULL_DISPOSABLE_CHAT_URL'
$callThreadId = 'REPLACE_WITH_DISPOSABLE_THREAD_ID'
$callInstance = 'REPLACE_WITH_CLAUDE_PROVIDER_INSTANCE_ID'
$callWav = 'REPLACE_WITH_ABSOLUTE_LOCAL_PCM_WAV_PATH'
$callBrowser = 'REPLACE_WITH_INSTALLED_CHROMIUM_BROWSER_EXE'

& $callNode scripts/otis-call-acceptance.mjs `
  --base-dir $callHome --origin $callOrigin `
  --thread-url $callThreadUrl --thread-id $callThreadId `
  --instance $callInstance --model claude-haiku-5-5 --effort medium `
  --wav $callWav --browser $callBrowser --expect-tool get_task `
  --output .logs/otis-call/medium-baseline

& $callNode scripts/otis-call-acceptance.mjs `
  --base-dir $callHome --origin $callOrigin `
  --thread-url $callThreadUrl --thread-id $callThreadId `
  --instance $callInstance --model claude-haiku-5-5 --effort medium `
  --wav $callWav --browser $callBrowser --expect-tool get_task `
  --disconnect --output .logs/otis-call/medium-disconnect
```

The helper retains pairing credentials only in memory. It writes bounded JSON
and `phone-call.png`, not transcript text or raw audio, to the selected ignored
directory. The parent must inspect the image, listen to real speech, and verify
interruption. Scheduled AudioBuffer playback is not an acoustic onset measurement.
After Sol fixes hang-up, the helper must still await voice-resource closure but
must not require the underlying chat to stop.

Raw proof comes from `$callHome/userdata/voice/calls/<callId>/`. The helper compares
PCM bytes/hash/length and stored transcript with the acknowledged utterance, then
checks one chat message and a completed expected Otis tool. Disconnect mode lets
the first upload reach the server and drops its response; retry must reuse its ID.
Add receipt-driven delivery-ack loss, disconnect during reply, and disposable
restart tests. Never run corruption/restart probes against production.

Repeat with supported low/default thinking and distinct output directories, using
the same warmed engines and WAV. Record sample counts, raw timings and medians;
missing observations stay null. Current helper limitations include actual effort
attestation, first-token precision, acoustic onset and late/truncated tool readback.
Sol must finish those measurements before recommending a different thinking setting.

## Parent review and release

Do not deploy this candidate. Complete the numbered jobs in architecture.md,
inspect decisive changes and real evidence, and run final affected checks.
Production release commands must come from the live T3 owner; no supported
production release command was established in this sandbox.

Sequence: resolve optional gate retention and model/client coverage; pass offline
checks; pass isolated real acceptance; identify any separate Otis release dependency;
obtain the live owner's candidate build, active-user safety, rollback and exact
release commands; parent commits/pushes; owner performs and verifies the authorized
release. Never restart 8085. No Otis branch or release currently exists for this work.

Review owned files before using `COMMIT_MSG.txt`. It has one task trailer and no
Co-Authored-By line. Rewrite it for the completed result if Sol finishes before
commit. Keep `.logs`, `.t3-call-acceptance`, recordings and private payloads out of
Git. The Git metadata is outside this sandbox's writable root; publication is the
parent's responsibility.
