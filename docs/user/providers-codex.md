# Codex

For one account, use the default Codex provider with your normal Codex login.
[Provider setup](./install.md#providers) covers installation, Settings > Providers,
and custom binaries or environment variables.

## Use multiple accounts

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. T3 Code prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3 Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
This requires a Codex version that supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.

## Choose browser and computer control

Open the model traits menu in a Codex thread and choose an available browser provider:

- **T3 managed Chrome** uses a separate Chrome profile owned by T3. It can navigate, inspect pages,
  fill fields, click controls, and take screenshots. It does not use your regular Chrome profile.
- **T3 Preview** uses the collaborative preview browser when agent browser access is enabled and a
  T3 desktop browser host is connected to the environment.

T3 offers only providers it can provision. Refresh the Codex provider in Settings after installing
Chrome or changing its availability. Selecting a provider does not start a browser or approve its
actions. Normal tool approvals still apply.

Expand a managed Chrome screenshot entry in the work log to view its image, then select the image
to enlarge it. Previews are available for new screenshot calls; older calls without a saved image
still show their recorded tool output. Images use the thread's authenticated attachment access,
including when you connect remotely.

Codex desktop Computer Use, the Codex built-in browser, and the Codex Chrome extension are separate
capabilities. On macOS, use the [Codex desktop bridge](../macos-codex-desktop-bridge.md)
to connect to the host daemon and its installed plugins. In regular CLI mode, installing those
plugins alone does not connect their desktop host to T3. T3 does not offer
them as working browser choices without that connection. A configured Computer Use skill can run
through the Codex session independently of the browser choice. The agent must check its host
connection and obtain app permission before controlling a window. Review that permission request
in T3, and avoid using Windows foreground input while the agent controls the selected app.

Older saved **Full desktop** selections use the available T3 browser route; they do not grant
Windows desktop control.

The `computer_open_url` tool can open a URL in your regular browser. Opening a URL does not give
the agent a way to inspect or control that browser afterward.

## Steer or stop a running turn

Choose **Steer active turn** to send an additional instruction to the running Codex turn. Its model
and permissions stay unchanged, and the instruction does not create a queued turn. If that turn
ends while the dialog is open, close the dialog before choosing another turn.

Choose **Stop generation** to interrupt the active turn. You can send another message in the same
thread afterward. T3 resumes the original Codex conversation; a failed resume reports an error
instead of silently starting a replacement conversation.

## Inspect native subagents

When Codex spawns subagents, choose **Open Agents** in the work log. The roster shows their reported
status, activity, model, and reasoning effort when Codex supplies them. Choose an agent's name to
see its identity, parent relationship, recent activity, and available result or error.

Agent details are a compact view of reported activity, not a separate interactive child
conversation. Nested agents appear when the runtime reports them; their availability depends on
that runtime's delegation tools and limits.
