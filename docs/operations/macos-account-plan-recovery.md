# Recovering a Mac provider after an account plan change

Older account decoders reject unfamiliar plan names before a turn starts. The
provider can then show a daemon connection error even when the daemon works.
The account response schema now accepts strings and ignores added fields.

For an installed desktop build that cannot be replaced yet,
`scripts/codex_account_plan_compat.py` is a temporary provider binary. Its
WebSocket helper preserves the managed desktop daemon, sign-in and tools. It
translates unfamiliar plan names to `unknown` only in account responses and
account notifications. Other protocol messages pass through unchanged.
Install both scripts together with the existing `ws` runtime dependency, then
select the Python script in the affected provider's Binary path setting.
The interpreter, managed Codex CLI and Node stay on their existing host paths.
No application bundle changes or desktop restarts are required.

Restore each previous Binary path through Settings > Providers after installing
a T3 build with the open account decoder. Retain the original instance and
its desktop-bridge setting. A provider refresh and a new throwaway turn must
both pass before removing the compatibility files. Never infer working
inference from the provider status alone.

`scripts/guard_macos_peer_tunnels.py --install` installs an Elora-only
LaunchAgent that runs every minute. Two consecutive failed or slow probes
restart only the affected tunnel. Recovery attempts, local state and logs live
under `~/.local/share/t3-peer-health`. It probes the T3 environment descriptor
on port 13773 and verifies Millie's environment identity. It does not change
CodexDeck or send messages.
The guard terminates only proxy processes whose parent is gone and whose PID,
start time and full command still match a second observation.

To uninstall the guard, boot out `gui/UID/com.t3tools.macos-peer-health` and
remove only its owned plist from `~/Library/LaunchAgents`. This leaves the
tunnel LaunchAgents and the provider compatibility setting intact.
