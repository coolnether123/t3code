# Codex

For one account, use the default Codex provider with your normal Codex login.
[Provider setup](./install.md#providers) covers installation, Settings > Providers,
and custom binaries or environment variables.

## Use the Codex desktop app

In **Settings > Providers**, turn on **Use Codex desktop app** for a Codex
instance to run its threads in the Codex desktop installation on the machine
hosting that environment. The host app supplies its sign-in, plugins, connectors,
browser extension, and approvals. The host bridge setup must be installed, and
the server must run on macOS. The shadow-home setting is hidden while this option
is on because the desktop installation owns the Codex home.

The setting is saved with the provider instance on its environment. You can
change it from a remote client; it does not switch the Mac or account used by
another environment. If the host daemon is unavailable, the instance shows its
connection error in provider settings, the model picker, and the thread. T3 does
not switch that instance to managed Chrome or silently choose another provider.

To keep one Codex instance out of new chats, turn off **Offer for new chats**
on that instance in **Settings > Providers**. Existing threads still use it,
and you can turn the switch back on at any time. The setting applies only to
the environment where you change it.

Existing chats show **Codex CLI** or **Codex desktop** in the chat header and
sidebar. On mobile, the same label appears above the chat and beside its list
entry. The label describes the chat's configured provider instance, not the app
you use to view it. If you change that instance's runtime setting later, the
label follows the setting; it is not a historical record of earlier turns.

In the web or desktop client, **Start desktop draft** on a Codex CLI chat opens a separate chat draft in
the same project and checkout when a desktop-backed Codex instance is ready.
It copies the currently loaded transcript into the unsent message. Earlier
turns may be omitted; load them first or add the missing context yourself.
Review and edit the message before sending. A transcript above the message
limit does not create a draft. This is text context, not a native
continuation: the desktop app gets a new provider thread, while the original
chat and its history stay unchanged. Files, attachments, approvals, and live
tool state do not transfer as active state.

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
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

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
