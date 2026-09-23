# macOS Codex quota sampler

The sampler reads the signed-in Codex account's `account/rateLimits/read` snapshot. It does not
open a thread, start a turn, or use an API key. Each Mac runs its own collector, so Millie can keep
sampling while Elora is shut down. T3 reads the history from
`T3CODE_QUOTA_HISTORY_PATH` when set, or from
`~/Library/Application Support/CodexLimits/state.json` on macOS.

## Manual check

From this repository, run:

```sh
bun apps/server/scripts/codex-quota-sampler.ts
```

The default output is
`~/Library/Application Support/CodexLimits/state.json`. To select another file, set
`T3CODE_QUOTA_HISTORY_PATH`. Node 24 can also run the TypeScript entrypoint on a host
without Bun. T3 must read the same path as the collector.

If T3 already has saved observations at
`~/.t3/userdata/usage-codex-quota-history.json`, preserve them. Before the first
collector run, check whether the external destination exists. Copy the old file
only when the external destination is absent, then verify the copied sample count.
Never replace an existing external history file with the old copy.

The first run records the percentage Codex reports at that moment. It cannot recover earlier
observations. A 100% sample is stored only when Codex reports 0% used. If a computer is asleep or
off during a reset, the sampler leaves that gap in the history rather than filling it with an
assumed full balance.

## Retain older observations

When the active `state.json` reaches 5,000 samples, the collector writes the oldest 1,000 rows to
`state.json.archive/<sha256>.json` before replacing the active file. Keep the archive directory
with `state.json` when copying or backing up quota history. If an archive write fails, the
collector leaves `state.json` unchanged and exits with an error. Repeating a run after a crash
reuses the identical archive chunk.

T3 reads the active file and up to 64 archive chunks. It verifies the archive filename against
the chunk's SHA-256 content, validates the observations, and deduplicates overlap after a crash.
Each chunk is limited to 1,000 rows and 256 KiB. If a chunk is damaged or the archive exceeds
these limits, the importer reports invalid history without deleting any source files. Collecting
continues independently of the T3 importer.

## LaunchAgent installation plan

The collector is designed to run once at login and every five minutes through a per-user
LaunchAgent. Install it only after confirming that Bun or Node 24 and the Codex executable are available to
the logged-in account. The `ProgramArguments` should invoke a stable copy of the script with the verified runtime, and
`EnvironmentVariables` should set `CODEX_BINARY_PATH` and, when needed,
`T3CODE_QUOTA_HISTORY_PATH`. Use a stable `Label`, `RunAtLoad`, and `StartInterval` of 300 seconds.
Keep `StandardOutPath` and `StandardErrorPath` in a user-owned logs directory. Do not put auth
tokens in the plist. The sampler inherits the user's Codex home and login state.

The code change alone does not install a LaunchAgent. Verify each Mac's actual runtime path, Codex binary,
T3 history path, and login behavior before creating or loading its plist. `launchd` runs only for
the logged-in user, and its timer cannot observe while the Mac is powered off. Sampling resumes
after wake or login.
