# Codex browser and desktop capability boundaries

T3 drives Codex through App Server. Browser automation remains a separate
capability. A Codex model, installed plugin, or connected remote environment does
not by itself give a T3 session browser or desktop control.

## Providers and ownership

| Provider                   | State owner                                                        | T3 integration                           |
| -------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| T3 managed Chrome          | T3 server, separate persistent Chrome profile                      | T3 `computer_*` MCP toolkit              |
| T3 preview                 | T3 collaborative preview                                           | T3 `preview_*` MCP toolkit               |
| Codex Chrome               | OpenAI desktop host and browser extension, regular browser profile | No supported T3 host adapter implemented |
| Codex built-in browser     | OpenAI desktop host, separate browser profile                      | No supported T3 host adapter implemented |
| Codex desktop Computer Use | OpenAI desktop host, app approvals, Windows foreground input       | No supported T3 host adapter implemented |
| Responses API computer use | The API integrator supplies screenshots and executes model actions | Not used by this integration             |

The OpenAI desktop documentation separates the
[built-in browser](https://learn.chatgpt.com/docs/browser),
[browser extension](https://learn.chatgpt.com/docs/chrome-extension), and
[Computer Use](https://learn.chatgpt.com/docs/computer-use). Windows Computer Use
operates on the active desktop. It needs app approvals and cannot share foreground
input with an actively working user.

T3 managed Chrome does not attach to the user's regular browser profile. The
`computer_open_url` tool can open a URL in that browser, but it supplies no
observation, screenshot, or input-control channel afterward. Do not label this
tool as a connected Codex Chrome provider.

## Capability discovery

`CodexBrowserCapabilities.ts` consumes the thread-scoped tool inventory from
`mcpServerStatus/list`. Follow pagination. The managed provider requires the
expected managed Chrome tools on the `t3-code` server. Preview has a separate
tool check because a session can receive either toolkit independently.

An available toolkit means the agent can attempt those tool calls. It does not
mean Chrome is running, authentication succeeded, or an action has approval.
Use the provider's status and action results for runtime state. Refresh discovery
when the tool catalog changes and before a new turn; do not retain availability
after disconnect or a failed inventory read.

The three Codex desktop entries remain unavailable in T3's capability report.
Their presence documents distinct provider identities; it does not make them
selectable. Add a desktop provider only after a supported host connection and its
approval, cancellation, target selection, and observation paths are implemented
and verified. Do not infer this support from:

- `remoteControl/status/changed`, which reports remote connection identity;
- `browser_use`, `browser_use_external`, or `computer_use` feature flags;
- a plugin name, skill file, or bundled package on disk;
- an MCP JavaScript execution tool being callable;
- app metadata that lacks an effective callable runtime state.

## Supported external tools

[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
supports independently configured tool servers. A user-supplied browser or OS
automation MCP server can therefore run through the same Codex conversation.
Preserve that server's tool identity and approvals. This is a custom MCP provider,
not proof that the OpenAI desktop Computer Use or Chrome host is portable.

The [App Server reference](https://learn.chatgpt.com/docs/app-server) documents
thread-scoped MCP inventory, tool calls, progress, results, and elicitation. It
also distinguishes `app/installed` effective runtime state from `app/read`
display-only metadata. The public reference currently marks the plugin
list/read/install/uninstall methods under development and tells production
clients not to use them. T3 must not make capability discovery depend on those
plugin-management methods.

The installed CLI 0.148.0 protocol exposes MCP tool calls but no dedicated
browser-navigation or Windows-input client request. The inspected local setup
also advertises a configured `node_repl` MCP server from the desktop app's bundled
runtime. That proves a tool transport exists, not that the browser or Computer Use
host is attached or publicly supported for third-party clients. No private
desktop endpoint, credential extraction, or copied browser state is part of T3's
integration.

## Model support is not host support

[GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) supports
computer use. The
[Responses API computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use)
requires the integrator to supply an execution environment and return screenshots.
That is a different integration from reusing Codex's desktop host. T3 does not
silently replace its ChatGPT-authenticated Codex session with separately billed
Responses API traffic.

The [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) provides another way to
control Codex sessions. Its documented session API is not a contract for attaching
the desktop app's browser or foreground-input host.

## Instructions and approvals

The persisted `computerControl` option retains `preview`, `chrome`, and the legacy
`desktop` value. `desktop` grants the T3 browser toolkit, not Windows access.
Instructions describe its managed Chrome fallback explicitly. The mode selection
does not grant permissions or authorize unrelated consequential actions.

`computerControlAvailable` in the instruction builder means the thread inventory
contains T3's managed Chrome toolkit. It defaults to false. The separate
`browserToolsAvailable` argument describes preview availability. Neither flag
should come from a remote-environment connection notification.

Keep Codex tool calls, progress, completion/error results, and approval requests
visible in the normal event path. Image-bearing MCP results belong to the tool
that produced them; do not relabel an arbitrary MCP image as a desktop frame.
Do not acknowledge permission requests automatically because a browser mode is
selected.

Sources and local protocol checked on 2026-08-30. This document describes T3's
implemented integration boundary, not a claim that future OpenAI clients or
versions cannot expose additional host support.
