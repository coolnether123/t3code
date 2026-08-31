# Prepare the daily-use local build

The Windows deployment launcher supports an existing service owner:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/launch-t3-code.ps1 -DryRun -Full -PrepareOnly
```

`-PrepareOnly` keeps the launcher's source synchronization, exclusions,
locked dependency installation, package checks, and web, server, and desktop
bundles. It does not stop or start processes or change Tailscale Serve.
Without `-PrepareOnly`, the launcher retains its Electron-owned hosting mode.

Before removing `-DryRun`, back up the deployment's actual files, service
configuration, and database. A live database needs a consistent SQLite backup,
not a plain file copy. Check all pages of `t3 agent snapshot` for active turns
and pending requests. Preparation changes served files even though it keeps
processes running.

After preparation, restart the verified service owner during an idle window.
Keep its existing T3 home, environment identity, authentication, and remote
origins. Recheck the deployed runtime with `t3 agent`, then verify client
rendering locally and through the existing Tailscale URL.

`prepared` is not a readiness claim. If a check or build fails, do not restart
into that partial build. Restore the backed-up code before continuing. Code
rollback must not replace the live conversation database with an older copy.
