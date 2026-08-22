# Codex desktop bridge on macOS

T3 Code can connect to the managed Codex daemon on a host Mac instead of
starting an isolated app-server process. Sessions created this way use the
host's durable Codex threads and its local Codex configuration, including
installed plugins, connected apps, Chrome, and Computer Use.

The bridge stays local to the host Mac. T3 reaches it through the existing T3
environment connection; it does not expose a Codex WebSocket or session files
to the network.

## Host Mac

This is the Mac that is signed in to Codex and owns the projects, Chrome
profile, plugins, and Computer Use permissions.

1. Install the current Codex desktop app and sign in.
2. In Codex, open **Settings > Connections > Computer** and turn on Remote
   Control.
3. Install and enable the Chrome and Computer Use plugins in Codex. Complete
   the Chrome extension setup and approve the macOS permissions requested by
   Computer Use.
4. Keep the Codex app open. Keep the Mac awake and connected to power while it
   is acting as a host.
5. From this repository, run:

   ```sh
   sh scripts/setup-macos-codex-desktop-bridge.sh
   ```

6. Start the T3 backend on this Mac. In **Settings > Providers > Codex**, enable
   **Use Codex desktop bridge**. Leave **Binary path** as `codex`; T3 checks the
   standard Codex and ChatGPT application bundle paths first. If the app is in
   a nonstandard location, enter its bundled binary explicitly, for example:

   ```text
   /Applications/Codex.app/Contents/Resources/codex
   ```

7. Leave **Shadow home path** empty. Desktop bridge mode deliberately uses the
   app's real Codex home so authentication, threads, plugins, and app
   connections stay consistent.

Use normal Codex plugin mentions in T3 prompts, such as `@Chrome`, and approve
requests in T3 when they are surfaced. Computer Use still enforces the host
Mac's app allowlist and system permissions.

## Regular Mac

This is the Mac where T3 is displayed.

1. Connect T3 to the host Mac using the existing SSH/Tailscale environment.
   Do not open an app-server port on either Mac.
2. Select the host environment and the Codex provider instance configured for
   desktop bridge mode.
3. Start or continue a thread normally. T3 sends turns through the host's local
   daemon proxy and streams the authoritative thread events back to this Mac.

## Verify or repair the host

Run these commands with the bundled binary shown during setup:

```sh
/Applications/Codex.app/Contents/Resources/codex app-server daemon version
/Applications/Codex.app/Contents/Resources/codex remote-control start --json
```

If the daemon is stale after an app update, stop and start it with the same
bundled binary:

```sh
/Applications/Codex.app/Contents/Resources/codex remote-control stop --json
/Applications/Codex.app/Contents/Resources/codex remote-control start --json
```

The desktop bridge uses the supported app-server protocol for thread reads,
turns, streaming, and approvals. It never writes `~/.codex/sessions` files or
uses macOS Accessibility scripting to type into the Codex window.
