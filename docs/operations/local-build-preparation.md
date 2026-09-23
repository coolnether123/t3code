# Prepare the daily-use local build

The Windows deployment launcher supports an existing service owner:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/launch-t3-code.ps1 -DryRun -Full -PrepareOnly
```

`-PrepareOnly` keeps the launcher's source synchronization, exclusions,
locked dependency installation, package checks, and web, server, and desktop
bundles. It does not stop or start processes or change Tailscale Serve.
Without `-PrepareOnly`, the launcher retains its Electron-owned hosting mode.

`-SkipTypecheck` is an explicit recovery valve for a dirty integration branch
with already-recorded typecheck failures outside the deployment change. It runs
all web, server, and desktop builds but records `build-without-typecheck` in the
deployment manifest. Run and retain the affected tests and focused lint before
using it. The default path still requires every package typecheck.

Before removing `-DryRun`, back up the deployment's actual files, service
configuration, and database. A live database needs a consistent SQLite backup,
not a plain file copy. Check all pages of `t3 agent snapshot` for active turns
and pending requests. Preparation changes served files even though it keeps
processes running.

After preparation, restart the verified service owner during an idle window.
Keep its existing T3 home, environment identity, authentication, and remote
origins. Recheck the deployed runtime with `t3 agent`, then verify client
rendering locally and through the existing Tailscale URL.

Every non-dry run writes `t3-deployment-<timestamp>.json` under the T3 home's
`userdata/verification` directory. The manifest records the source branch and
commit, a hash and file list for the exact dirty source projection, the detached
deploy commit, hashes for the server, web, and desktop entry artifacts, the
toolchain, endpoints, and protected exclusions. Use this manifest with the
preparation backup to identify the exact rollback candidate. Restore code and
artifacts only. Do not replace the live conversation database during a code
rollback.

`prepared` is not a readiness claim. If a check or build fails, do not restart
into that partial build. Restore the backed-up code before continuing. Code
rollback must not replace the live conversation database with an older copy.

On macOS, the packaged-app workflow is documented in
[macOS local desktop deployment](./macos-local-deployment.md). It uses the
repository's DMG/ZIP builder, keeps the existing `T3CODE_HOME` and Electron
support data, and performs a recoverable same-filesystem app swap without
changing launchd or Tailscale configuration.
