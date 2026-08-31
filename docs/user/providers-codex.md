# Codex

This guide is for people who want to use more than one Codex account in T3 Code. For Claude, see
[Claude](./providers-claude.md). For first-time setup, see [Install T3 Code](./install.md).

Common reasons:

- use a work account for work projects
- use a personal account for personal projects
- switch to another account when one account hits limits
- keep one shared Codex history instead of maintaining two separate Codex setups

## I Only Use One Codex Account

Use the default provider.

In Settings, your Codex provider can stay like this:

```text
Display name: Codex
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

Log in with Codex normally:

```bash
codex login
```

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` or `/feedback` followed by a description of the
issue. T3 Code uploads the thread and Codex logs to OpenAI and shows a thread ID that you can copy
and share with OpenAI employees.

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
capabilities. Installing those plugins does not connect their desktop host to T3. T3 does not offer
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

## I Want Work And Personal Codex Accounts

Use one real Codex home and one shadow home.

Recommended setup:

```text
~/.codex      shared Codex home
~/.codex_p    second account auth
```

The idea is:

- both accounts can see the same T3/Codex sessions
- each account keeps its own login
- existing threads can continue with either account

### Set Up The First Account

Log in normally:

```bash
codex login
```

This is the account used by `~/.codex`.

In T3 Code Settings, name it something obvious:

```text
Display name: Codex Work
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

### Set Up The Second Account

Log in with a separate Codex home:

```bash
mkdir -p ~/.codex_p
CODEX_HOME=~/.codex_p codex login
```

In T3 Code Settings, add another Codex provider:

```text
Display name: Codex Personal
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex_p
```

The important part is that both providers use the same `CODEX_HOME path`, but only the second one
has a `Shadow home path`.

## Which Account Am I Using?

Open Settings and look at the provider row.

T3 Code shows the authenticated email for providers that report one. Emails are blurred by default;
click the blurred email to reveal it.

Use display names and accent colors to make accounts easy to tell apart in the model picker.

## I Need A Different API Key Or Endpoint

Use the provider's Environment variables section in Settings.

This is useful when a Codex-compatible setup needs account-specific variables. Add the variables to
the provider instance that should receive them, and mark API keys or tokens as sensitive. Sensitive
values are stored as server secrets and are not sent back to the app after saving.

## Can I Switch Accounts In An Existing Thread?

Yes, when both Codex providers share the same `CODEX_HOME path`.

For example:

```text
Codex Work      CODEX_HOME path: ~/.codex
Codex Personal  CODEX_HOME path: ~/.codex, Shadow home path: ~/.codex_p
```

Those two providers are considered compatible for continuation, so the locked model picker can show
both.

If you add a third Codex provider with a completely different `CODEX_HOME path`, T3 Code treats it
as a different workspace. It will not be offered for existing threads created under `~/.codex`.

## If Both Accounts Look The Same

If two Codex providers show the same account or the same unexpected model list:

1. Check the email in Settings.
2. Refresh provider status.
3. Confirm the second provider has `Shadow home path` set.
4. Confirm the shadow directory has its own `auth.json`.
5. If you copied `~/.codex` into the shadow directory, remove everything except `auth.json`.

Example cleanup:

```bash
find ~/.codex_p -mindepth 1 ! -name auth.json -exec rm -rf {} +
```

## When To Use A Separate CODEX_HOME

Use a totally separate `CODEX_HOME path` only when you want a separate Codex workspace.

That means separate sessions and less account switching inside old threads. Most dual-account users
should use the shared-home plus shadow-home setup instead.
