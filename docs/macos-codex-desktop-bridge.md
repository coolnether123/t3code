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
2. Install the standalone Codex CLI from the [official CLI instructions](https://developers.openai.com/codex/cli/).
   The desktop app bundle alone is not enough for daemon management: the setup
   script reads `codex-package.json` and uses its `entrypoint`. Current packages
   use `~/.codex/packages/standalone/current/bin/codex`. Older packages without
   an entrypoint can use `~/.codex/packages/standalone/current/codex`. If
   `CODEX_HOME` is set, use the same value when running setup and starting T3.
3. Keep the Codex desktop app signed in. Remote Control is not required for the
   T3 desktop bridge; the bridge uses the local app-server daemon.
4. Install and enable the Chrome and Computer Use plugins in Codex. Complete
   the Chrome extension setup and approve the macOS permissions requested by
   Computer Use.
5. Keep the Codex app open. Keep the Mac awake and connected to power while it
   is acting as a host.
6. From this repository, run:

   ```sh
   sh scripts/setup-macos-codex-desktop-bridge.sh
   ```

7. Start the T3 backend on this Mac. In **Settings > Providers > Codex**, enable
   **Use Codex desktop app**. Leave **Binary path** as `codex`; T3 checks the
   standard Codex and ChatGPT application bundle paths first. If the app is in
   a nonstandard location, enter its bundled binary explicitly, for example:

   ```text
   /Applications/Codex.app/Contents/Resources/codex
   ```

8. Leave **Shadow home path** empty. Desktop bridge mode deliberately uses the
   app's real Codex home so authentication, threads, plugins, and app
   connections stay consistent.

Use normal Codex plugin mentions in T3 prompts, such as `@Chrome`, and approve
requests in T3 when they are surfaced. Computer Use still enforces the host
Mac's app allowlist and system permissions.

For desktop-backed threads, T3 attaches the enabled bundled plugins' skill
directories from the local `openai-bundled` marketplace in the host's Codex
config. Disabled plugins and missing skill directories are skipped. Provider
status refresh lists the same daemon skills. If the config cannot be read or
the daemon rejects the skill roots, the thread still opens; its **Tools
attached to this thread** activity reports why the skills were not attached.
Check the host's `CODEX_HOME/config.toml` (or `~/.codex/config.toml`) and the
daemon when this warning appears. The skills do not bypass host approvals or
prove that a browser connection is available.

Each T3 provider session receives its own MCP credential. For desktop-daemon
threads, T3 sends the server URL and authorization header in `thread/start` or
`thread/resume`; it does not put the credential in the proxy environment. The
protocol logger redacts HTTP header values, and provider events and activities
do not contain the credential. T3 revokes the credential when that provider
session stops. The daemon uses it to authenticate requests to T3's MCP server.

After a daemon thread starts or resumes, T3 records one activity named
**Tools attached to this thread**. It lists up to 40 MCP server names, startup
and authentication status, and tool counts. It also says whether `cua_repl` and
`node_repl` are attached. This is a thread inventory, not a claim that a browser
is available. It does not include tool schemas or connector account details.

## Regular Mac

This is the Mac where T3 is displayed.

1. Connect T3 to the host Mac using the existing SSH/Tailscale environment.
   Do not open an app-server port on either Mac.
2. Select the host environment and the Codex provider instance configured for
   desktop bridge mode.
3. Start or continue a thread normally. T3 sends turns through the host's local
   daemon proxy and streams the authoritative thread events back to this Mac.

## Verify or repair the host

Run these commands with the standalone managed CLI path used by setup. The
usual path is:

```sh
"${CODEX_HOME:-$HOME/.codex}/packages/standalone/current/bin/codex" app-server daemon bootstrap
"${CODEX_HOME:-$HOME/.codex}/packages/standalone/current/bin/codex" app-server daemon version
```

If that package only has the older layout, replace `bin/codex` with `codex`.
The setup script checks the reported status and stops unless it is `running`.

The app-bundled binary printed by setup is used for desktop-app discovery and
opening the app. It is not a substitute for the standalone managed CLI. If the
managed path is missing, install the CLI from the [official CLI instructions](https://developers.openai.com/codex/cli/)
and rerun setup; the script does not install it silently.

`daemon bootstrap` is the supported repair path after an app update. It
reconciles the durable managed daemon with the bundled client; it does not
enable Remote Control or expose a new network endpoint. Run `daemon version`
again afterward and confirm that the reported daemon is running.

When the provider status reports that the socket is missing, the proxy exited,
the handshake failed, or the desktop app is not signed in, T3 marks that
provider instance as an error. It does not start a separate stdio app-server.
Run `app-server daemon bootstrap` and then `app-server daemon version` with the
standalone managed Codex CLI shown above (not the desktop-bundled binary);
confirm the output contains `"status":"running"`. If the app is not signed in,
sign in to the desktop app as well.

The desktop bridge uses the supported app-server protocol for thread reads,
turns, streaming, and approvals. It never writes `~/.codex/sessions` files or
uses macOS Accessibility scripting to type into the Codex window.
