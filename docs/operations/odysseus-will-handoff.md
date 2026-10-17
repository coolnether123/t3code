# Will's T3 setup

Use the browser for Elora and Millie now. Add a local installation when you want
agents to work on your laptop. Each agent works on the computer selected in T3.

## Approve access

Keep Odysseus on Tailscale. Obtain a fresh pairing link from each Mac's operator.
Open one link, then add the other through **Settings → Connections → Add
environment**. Use the same browser profile. No laptop install is needed for
this. Pair only with access the Macs' owner has approved.

For remote maintenance, allow SSH only from Jared's PC using the dedicated
`odysseus_otis` public key and your restricted `otis` account. Do not allow a
general shell, arbitrary PowerShell, file upload, port forwarding, or npm
commands. The exact four command mappings are in
[the broker instructions](./odysseus-maintenance.md).

## Install locally

Review the kit from the agreed Git revision. In your normal Windows account,
run this from the kit's repository directory:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\odysseus\t3-user.ps1 -Action Install
```

This downloads stable T3, Codex CLI, and portable Node into your user profile.
It does not need administrator rights. Install Git for Windows for your user if
it is missing. The script does not change your existing tools or startup tasks.

Which ChatGPT/Codex account do you want to use for local agents? Choose it
before signing in. Do not use Jared's or Christine's credentials.

Use the installed release to sign in yourself:

```powershell
$root = "$env:LOCALAPPDATA\OdysseusT3"
$m = Get-Content "$root\current.json" -Raw | ConvertFrom-Json
$r = "$root\releases\$($m.directory)"
$env:PATH = "$r\$($m.nodeDir);$r\packages\node_modules\.bin;$env:PATH"
codex.cmd login
```

Complete the browser sign-in yourself. If Windows sandbox setup requests
administration, review and run that step yourself. Start the server with the
same script command as above, replacing `Install` with `Start`. It runs without
a new window. Then, in your local terminal, run:

```powershell
t3.cmd pair --base-dir "$root\data"
```

Open the fresh local pairing link yourself. Keep it private. Add the Macs using
their fresh links in this local client's Connections page to see all three.
Create a disposable project and ask Codex to create a short text file. Confirm
that you can select each Mac and see its chats before using real work.

## Maintain it

`Health` checks installed versions, Git, and the local HTTP response. It does
not prove a signed-in agent works. After all local agents finish, `Stop` stops
only this kit's server. `Update` installs current stable versions; then use
`Start` again. Your conversations stay in the same data directory.

For Otis to do maintenance, run the separate broker setup yourself as described
in the broker instructions. Its jobs run as you, without elevation, only while
you are signed in. `t3-status` reads results. Remove the three broker tasks and
the four allowlist entries to revoke maintenance access. Revoke paired devices
in T3 Connections separately.
