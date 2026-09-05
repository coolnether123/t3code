# macOS peer access for Wanda and Millie

This runbook describes the host-local SSH and T3 connection between the two
Macs. It keeps the existing CodexDeck connection separate from a durable
Millie-to-Wanda T3 tunnel.

## Connection layout

On Millie, the peer tunnel listens on `127.0.0.1:13773` and forwards through
the `wanda-codex` SSH alias to Wanda's loopback T3 server at
`127.0.0.1:3773`:

```text
Millie 127.0.0.1:13773
    │  SSH local forward through wanda-codex
    ▼
Wanda 127.0.0.1:3773
```

The SSH alias, private key, known-host entry, and authorized key remain in the
host-local `~/.ssh` directories. Nothing in this repository contains a key or
credential.

The two existing connections are separate and must stay in place:

- Wanda's managed T3 connection uses its existing SSH forward to Millie's
  loopback T3 port. Keep its current local port and owner unchanged.
- CodexDeck uses the existing `com.christine.codexdeck.tunnel` LaunchAgent
  and remote loopback port `8787`. Do not point this installer at `8787` or
  replace that LaunchAgent.

## Prerequisites

Before installing the peer tunnel, verify the following on the Mac that will
run the LaunchAgent (normally Millie):

1. macOS is awake and connected to power when the tunnel is needed. `KeepAlive`
   reconnects after a sleep or network interruption, but it cannot connect to
   a powered-off Mac.
2. Tailscale is connected on both Macs.
3. The SSH alias is already configured and its ED25519 host key is present in
   `~/.ssh/known_hosts`. Keep strict host-key checking enabled.
4. The peer T3 server is already running on `127.0.0.1:3773`.

Check the alias before installing:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=15 wanda-codex 'hostname; whoami'
```

The command must identify Wanda's Mac and the expected macOS user. A failed
login, host-key warning, or unexpected identity is a stop condition.

## Install or review the tunnel

Run the installer from a checkout of this repository on Millie. Start with a
no-write plan:

```sh
python3 scripts/setup-macos-peer-tunnel.py \
  --ssh-alias wanda-codex \
  --local-port 13773 \
  --remote-port 3773 \
  --dry-run
```

The default values are the same, so the short form is equivalent:

```sh
python3 scripts/setup-macos-peer-tunnel.py --dry-run
```

After reviewing the alias, ports, and LaunchAgent path, run the same command
without `--dry-run`. It creates
`~/Library/LaunchAgents/com.t3tools.macos-peer-tunnel.plist` with owner-only
permissions and loads it into the current user's launchd domain. It does not
create SSH keys, change `~/.ssh`, or copy data between machines.

The installer refuses to overwrite a different plist at that path. It also
refuses to claim a local port already held by another process. Choose an
explicit unused local port and review the existing owner before retrying.

The generated SSH command uses:

- `BatchMode=yes`, so it cannot hang waiting for a password;
- `ExitOnForwardFailure=yes`, so a half-open forward exits;
- `ConnectTimeout=15`;
- `ServerAliveInterval=30` and `ServerAliveCountMax=3`;
- `RunAtLoad` and `KeepAlive`; and
- `ThrottleInterval=30` to avoid a rapid retry loop.

## Verify the installed service

Inspect the user job and its listener without restarting it:

```sh
launchctl print "gui/$(id -u)/com.t3tools.macos-peer-tunnel"
lsof -nP -iTCP:13773 -sTCP:LISTEN
curl --max-time 5 -sS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:13773/
```

The HTTP response depends on the T3 server's route, but the listener should be
owned by the managed SSH process and the request should reach the peer. If the
peer is asleep or T3 is stopped, the listener may be absent until launchd
reconnects successfully.

To stop the service deliberately, unload the exact label and then remove the
plist after reviewing it:

```sh
launchctl bootout "gui/$(id -u)/com.t3tools.macos-peer-tunnel"
```

Do not stop the Deck tunnel or Wanda's existing T3 forward while diagnosing
this service.

## SSH, file, and Codex session access

The peer SSH setup supports shell and SFTP access in both directions. Use the
existing aliases and normal host-local keys:

```sh
# From Millie to Wanda
ssh wanda-codex 'hostname; whoami'
sftp wanda-codex

# From Wanda to Millie
ssh millie-codex 'hostname; whoami'
sftp millie-codex
```

For a bounded file transfer, use a task-specific Workroom staging path and
verify the destination before replacing anything. Do not copy the two
workrooms wholesale, and do not copy or edit Codex SQLite databases while
Codex is running.

Codex session metadata can be listed or read remotely without changing the
session store:

```sh
ssh wanda-codex \
  'find ~/.codex/sessions -maxdepth 2 -type d -print | sort | tail -20'
ssh wanda-codex \
  'stat -f "%N size=%z modified=%Sm" -t "%Y-%m-%d %H:%M:%S %z" \
    ~/.codex/session_index.jsonl'
```

Use `ssh millie-codex` for the corresponding Millie metadata. A session listing
does not grant permission to merge, copy, or rewrite session history.

## Failure checks

- `Permission denied`: verify the exact alias, user, key fingerprint, and
  source restriction in `authorized_keys`. Do not switch to password prompts
  or disable `BatchMode`.
- Host-key failure: compare the live ED25519 fingerprint with the machine's
  verified host key, then repair `known_hosts` through the normal SSH workflow.
  Never add `StrictHostKeyChecking=no` to the LaunchAgent.
- Port conflict: inspect the owning process and the existing LaunchAgent
  before selecting a new local port. The installer intentionally stops rather
  than overwriting another owner's plist or listener.
- No response from port `3773`: confirm T3 is running on the peer and that
  Tailscale is connected. Do not restart another agent's T3 process from this
  runbook.

