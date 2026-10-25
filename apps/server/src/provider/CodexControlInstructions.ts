import { type SubagentBackend } from "@t3tools/contracts";
import {
  type CodexComputerControlMode,
  DEFAULT_CODEX_COMPUTER_CONTROL_MODE,
} from "./CodexComputerControl.ts";
const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code collaborative browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the T3 preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed T3 preview tool call should be inspected and retried with corrected arguments when the error is actionable.
`;

const T3_CODE_CHROME_TOOL_INSTRUCTIONS = `

## T3 managed Chrome

The \`t3-code\` MCP server exposes managed Chrome tools. For browser work in this provider, call \`computer_start\` or \`computer_status\`, use \`computer_tabs\` and \`computer_select_tab\` when choosing a tab, then \`computer_navigate\`, \`computer_snapshot\`, \`computer_click\`, \`computer_fill\`, and \`computer_type\`. Use refs from the latest \`computer_snapshot\` for interaction, and call \`computer_close\` when the browser session is no longer needed.

These tools operate T3's separate persistent Chrome profile. They do not control the user's regular Chrome profile, the Codex Chrome extension, the Codex built-in browser, or Windows desktop applications. If the user explicitly requests one of those targets, check its installed skill and configured tools. Explain this toolkit's limitation before proposing a different provider or profile; do not treat it as proof that the requested provider is unavailable.

Tool availability is not an approval. Follow the task's sandbox, tool approvals, and confirmation requirements. A browser-provider selection does not authorize new sites, uploads, purchases, account changes, or other consequential actions beyond the user's request. Inspect tool errors and report missing authentication or unavailable runtime controls without inventing access.

If \`computer_open_url\` is listed, it can open a URL in the user's Chrome browser. Opening a URL does not provide observation or input control over that browser. Do not claim that it does.
`;

const CODEX_DESKTOP_APP_INSTRUCTIONS = `

## Codex desktop browser and computer tools

This thread runs through the host's Codex desktop installation. When a user requests Chrome or mentions @Chrome, use the Codex Chrome browser-extension route and follow its installed skill and the host's site permissions and action-time confirmations. The Chrome extension is distinct from Windows Computer Use through Sky via node_repl. Do not substitute Sky, the built-in browser, T3 managed Chrome, or T3 Preview for a requested Chrome extension. If Chrome extension tools are not exposed in this session, report that instead of switching browsers. T3 managed Chrome and T3 Preview are separate tools, not fallbacks for the host extension.
`;

const CODEX_DESKTOP_CONTROL_LIMITATION = `

## Desktop control availability

The saved desktop-control preference alone does not attach Codex desktop Computer Use to T3. T3's managed Chrome is a browser-only fallback with its own profile. Do not claim access to Windows input, screenshots, or Codex app browser sessions from this preference, a plugin name, or a remote-control connection.

An independently configured MCP server may provide desktop tools, including a JavaScript runtime used by the installed Computer Use skill. Check that route through its documented API before reporting desktop control unavailable.
`;

const CONFIGURED_COMPUTER_USE_INSTRUCTIONS = `

## Configured Windows Computer Use

The Browser provider preference selects T3's browser toolkit; it does not disable independently configured MCP tools or skills. For a Windows app task, inspect the installed Computer Use skill and the current turn's tools before claiming Computer Use is unavailable.

When the task permits Windows automation and that skill and its configured JavaScript tool are available, read the skill and its runtime, API, and confirmation guidance. Use the documented package entry point through the existing runtime. Start with the skill's lightweight host check in the current session. A callable JavaScript tool alone does not prove that the host is connected. Do not install a bridge, spawn a helper, use private endpoints, or bypass a failed connection.

Host reachability is not app approval or permission to act. Select exactly one target window from returned app/window objects, follow host app approvals and the skill's action-time confirmations, and retain its prohibited targets and actions. Windows input uses the active desktop, so coordinate foreground ownership with the user. Observe the selected window before acting, refresh after each action, and stop on cancellation or a locked desktop. Do not reuse stale window state after an error or runtime reset.
`;

function computerControlInstructions(
  mode: CodexComputerControlMode,
  browserToolsAvailable: boolean,
  computerControlAvailable: boolean,
): string {
  if (mode === "preview") return browserToolsAvailable ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "";
  const browserInstructions = computerControlAvailable
    ? T3_CODE_CHROME_TOOL_INSTRUCTIONS
    : browserToolsAvailable
      ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS
      : "";
  return `${browserInstructions}${mode === "desktop" ? CODEX_DESKTOP_CONTROL_LIMITATION : ""}`;
}

const CODEX_NATIVE_SUBAGENT_PARENT_INSTRUCTIONS = `

## Codex native sub-agents

The selected Codex app-server model runtime controls the callable sub-agent tools for this turn. The user creates only the parent thread. The parent agent creates and controls its sub-agents; do not ask the user to create, start, steer, or configure one. Keep delegation single-level unless the selected runtime contract and an explicit policy allow recursion. Do not instruct a child agent to create another child.
`;

/**
 * The browser block is omitted entirely when the preview tools aren't attached.
 * Describing `preview_*` tools that aren't in the turn's tool list would be
 * worse than saying nothing: the instructions actively steer the model away
 * from Playwright and agent-browser, so leaving them in would talk it out of
 * the only browser automation it still has.
 */
export interface CodexControlRuntime {
  readonly useDesktopAppDaemon?: boolean | undefined;
  readonly computerControlAvailable?: boolean | undefined;
  readonly computerControlMode?: CodexComputerControlMode | undefined;
  readonly subagentBackend?: SubagentBackend | undefined;
}
export function buildCodexControlInstructions(
  runtime: CodexControlRuntime,
  browserToolsAvailable: boolean,
): string {
  const desktopAppTools = runtime.useDesktopAppDaemon && !runtime.computerControlAvailable;
  return [
    desktopAppTools
      ? CODEX_DESKTOP_APP_INSTRUCTIONS
      : computerControlInstructions(
          runtime.computerControlMode ?? DEFAULT_CODEX_COMPUTER_CONTROL_MODE,
          browserToolsAvailable,
          runtime.computerControlAvailable ?? false,
        ),
    desktopAppTools ? "" : CONFIGURED_COMPUTER_USE_INSTRUCTIONS,
    runtime.subagentBackend === "v1" || runtime.subagentBackend === "v2"
      ? CODEX_NATIVE_SUBAGENT_PARENT_INSTRUCTIONS
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
