# Odysseus installation decision

Recommend the stable T3 web client with three paired environments. Use the
existing Mac servers for Elora and Millie. Install a separate per-user T3 server
and Codex CLI on Odysseus for local work. A new Otis service is unnecessary for
viewing or using the Macs' agents.

## Remote work

While connected to the tailnet, Will opens a fresh pairing link supplied by each
Mac's authorized operator. In the same browser profile, use **Settings →
Connections → Add environment** to add the other Mac. Pairing grants access to
that environment's work and agents, so its owner chooses the permitted scope.
The Macs must remain awake and their servers available. This requires no
Odysseus install, inbound laptop firewall rule, or local provider sign-in.

## Local work

`scripts/odysseus/t3-user.ps1` installs the registry's current stable `t3` and
`@openai/codex` with a checksum-verified portable Node 24 runtime under
`%LOCALAPPDATA%\OdysseusT3`. It changes no machine installation or persistent
PATH. Git for Windows must be installed separately. Each release records its
versions and npm lockfile. Package lifecycle scripts are disabled.

This uses stock stable T3, not the customized Windows source deployment. It
does not carry Jared's fork-only features, provider settings, accounts, or data.
The repository's existing launcher is tied to Jared's paths, deployment mirror,
ports, and service ownership, so copying it to Odysseus would be inappropriate.

The local server binds only to `127.0.0.1:3784`. Will can pair the Macs into its
browser client as well. Odysseus does not need to accept T3 connections from
other machines to meet this request. HTTPS Mac clients and the local HTTP
client may keep separate connection lists because browser storage belongs to
each origin. Add both Mac environments to the local client for a single view.

## Restricted maintenance

The optional broker exposes only `t3-install`, `t3-update`, `t3-health`, and
`t3-status`, with no caller arguments. Three on-demand scheduled tasks execute
the maintenance script as Will with limited privileges and an interactive
token. They store no password and require Will to be signed in. The `otis`
account can execute these tasks and read sanitized receipts. It cannot alter
the tasks, approved scripts, or Will's private installation. Updates download
executable code from the official Node distribution and npm registry; approving
update authority includes trusting those publishers.

Installation and updates stage a fresh release before changing `current.json`.
They refuse while the owned server runs or its configured port is occupied.
They never restart agents. The preceding release stays available through
`previous.json`. A code rollback must never replace the conversation database.
Before any future data migration, keep a consistent SQLite backup and verify
backward compatibility before restoring older code.

## Acceptance still needed on Odysseus

Will must approve the broker and firewall scope, identify his Windows account,
choose his Codex account, and complete his own sign-in. Nobody needs his
password. Sandbox setup requiring administration is Will's step; the kit does
not disable sandbox controls or preselect a weaker mode. Test a synthetic local
project and select each Mac in the client before calling the laptop ready.

References: [T3 distribution](https://t3.codes/download),
[Codex authentication](https://developers.openai.com/codex/auth),
[Windows sandbox](https://developers.openai.com/codex/windows), and this
revision's `docs/user/install.md` and `docs/user/remote-access.md`.
