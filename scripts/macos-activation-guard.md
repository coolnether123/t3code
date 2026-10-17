# One-off macOS activation guard

This helper checks admission only. It never stops a process, starts deployment,
writes live SQLite, creates messages, installs launchd jobs, or adds a schedule.
Do not execute, repoint, or reuse an older private deployment job. Prepare a
fresh owner-only task directory and manifest on each intended host.

The parent operator supplies the reviewed host-local manifest. Never put the
manifest, baseline, process commands, database rows or credentials in Git.
Manifest keys are documented in `macos-activation-guard.py`'s module docstring.
Use `version: 1`; `expires_at` is an explicit Unix deadline no more than 24 hours
ahead. `allocation_bytes` is the conservative _remaining_ allocation for the
deployment, not merely the candidate size. The projected reserve is 20 GiB.

`processes` includes the current listener and, for desktop deployment, the exact
app root. Each pin has numeric `pid` and `uid`, `started` equal to stripped
`/bin/ps -p PID -o lstart=` output, and `command_sha256` equal to SHA-256 of
stripped `/bin/ps -ww -p PID -o command=` output. Never print that command if it
may contain credentials. The endpoint is the literal current loopback origin.
No PID is rediscovered or substituted after the manifest is prepared.

Pin `candidate_identity_file` to the prepared app's `Contents/Resources/app.asar`
or backend candidate's `dist/bin.mjs`, and set its exact SHA-256 after the
candidate's existing build/deployer validation. The normal backend deployer
separately validates `.t3-source-commit`; hashing that marker alone does not
pin executable bytes. `commit` is the full source
commit, not a branch, prefix, or remembered release. `node` is the verified
Node executable supporting the existing native socket's WebSocket dependency.
`ws_require_from` is an absolute existing package.json from which `ws` resolves.
`native_socket` is the current account's existing app-server-control socket.
`database` and `environment_file` name the exact existing live T3 home.
`baseline_file` must be absent and its parent owner-only. There are no secrets
in the manifest. It does not grant additional deployment authority.

For an explicit immediate admission, use these separately reviewed commands
with real absolute paths for that host:

```sh
export T3CODE_GUARD_MANIFEST=/absolute/private/current-task/manifest.json
export T3CODE_PRESTOP_GUARD=/absolute/reviewed/scripts/macos-activation-guard.py
export T3CODE_PRESERVE_PENDING_REQUESTS=1
/usr/bin/python3 "$T3CODE_PRESTOP_GUARD" --capture
/usr/bin/python3 "$T3CODE_PRESTOP_GUARD" --gate-only
```

For a finite one-off CLI wait, replace `--capture` with
`--wait-seconds 1800`. That invocation admits two unchanged idle observations,
creates the baseline exclusively and exits. Its alarm bounds the entire wait,
including native RPC time. It never launches deployment or persists a waiter.
It retries proven activity only; missing proof, identity/process/pending drift,
or expiration exits held. A parent-owned one-off runner may then call the
already authorized, exact-pinned normal desktop/backend deploy command. Both
normal deployers call `--gate-only` immediately before their normal stop.
Keep all other normal backup, candidate, process, capacity and rollback gates.

`--gate-only` is read-only and requires the captured baseline. It checks current
host/account/home, source/candidate identity, environment file and endpoint,
exact PID/start/command, sole loopback listener, projected disk reserve, SQLite
runtime/projection/streaming state, native paginated global idle state across
both archived states and every source kind including subagents, and each
running runtime's native binding plus latest terminal turn. Pending approval,
input-thread and input-event rows are fingerprinted, not discarded. The native
proof uses only initialize, thread/list, thread/read without turns, and
thread/turns/list with notLoaded items. It never resumes or changes a thread.

Unknown state, RPC failures, missing mappings, inconsistent snapshots, process
shutdown/replacement and changed pending fingerprints all hold activation.
Current root-agent activity therefore refuses Elora admission. Stale running
or starting projections with a running runtime also hold; this helper has no
blanket stale-row exemption. A known stale archived synthetic test row needs
its own reviewed row-specific reconciliation or waiver with native terminal
turn and quiet side-effect proof. Do not mark it idle merely because it is old.
Baseline recapture is deliberately refused. Reconcile changed state and prepare
a fresh task scope rather than silently widening an admitted deployment.
The same rule applies to rollback: once the original pinned PID has stopped,
the old guard cannot admit stopping a replacement candidate. Reconcile that
candidate and prepare a separate explicit process-scoped rollback manifest.

Synthetic verification, with no real native socket or live writes:

```sh
python3 -B -m unittest discover -s scripts -p test_macos_activation_guard.py -v
node --test scripts/macos-native-idle.test.mjs
```
