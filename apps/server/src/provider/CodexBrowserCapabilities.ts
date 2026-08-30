/** A thread-scoped inventory returned by Codex `mcpServerStatus/list`. */
export interface CodexMcpToolInventory {
  readonly name: string;
  readonly tools: Readonly<Record<string, unknown>>;
}

export const T3_MANAGED_CHROME_TOOLS = [
  "computer_start",
  "computer_status",
  "computer_tabs",
  "computer_select_tab",
  "computer_navigate",
  "computer_snapshot",
  "computer_click",
  "computer_fill",
  "computer_type",
  "computer_close",
] as const;

export const T3_PREVIEW_BROWSER_TOOLS = [
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_snapshot",
  "preview_click",
  "preview_type",
] as const;

const hasT3Tools = (
  servers: ReadonlyArray<CodexMcpToolInventory>,
  requiredTools: ReadonlyArray<string>,
): boolean =>
  servers.some(
    (server) =>
      server.name === "t3-code" &&
      requiredTools.every((name) =>
        Object.prototype.hasOwnProperty.call(server.tools, name),
      ),
  );

/** Tool availability does not imply that Chrome has started or that an action is approved. */
export const hasT3ManagedChromeTools = (
  servers: ReadonlyArray<CodexMcpToolInventory>,
): boolean => hasT3Tools(servers, T3_MANAGED_CHROME_TOOLS);

export const hasT3PreviewBrowserTools = (
  servers: ReadonlyArray<CodexMcpToolInventory>,
): boolean => hasT3Tools(servers, T3_PREVIEW_BROWSER_TOOLS);

export interface CodexBrowserCapability {
  readonly id:
    | "t3-managed-chrome"
    | "codex-chrome"
    | "codex-browser"
    | "codex-computer-use";
  readonly label: string;
  readonly available: boolean;
  readonly reason: string;
  readonly transport: "mcp" | "desktop-host";
  readonly profile: "t3-managed" | "user-browser" | "codex-browser" | "desktop";
}

/**
 * The desktop integrations require a supported host adapter, not just an installed
 * plugin, a feature flag, `node_repl`, or a remote-control connection. T3 has none.
 */
export function resolveCodexBrowserCapabilities(
  servers: ReadonlyArray<CodexMcpToolInventory>,
): ReadonlyArray<CodexBrowserCapability> {
  const managedChromeAvailable = hasT3ManagedChromeTools(servers);
  return [
    {
      id: "t3-managed-chrome",
      label: "T3 managed Chrome",
      available: managedChromeAvailable,
      reason: managedChromeAvailable
        ? "T3 browser tools are attached. Chrome uses a separate persistent profile; start it to check runtime readiness."
        : "The complete T3 managed Chrome tool catalog is not attached to this Codex thread.",
      transport: "mcp",
      profile: "t3-managed",
    },
    {
      id: "codex-chrome",
      label: "Codex Chrome",
      available: false,
      reason:
        "T3 has no supported adapter to the Codex desktop browser-extension host or its normal browser profile.",
      transport: "desktop-host",
      profile: "user-browser",
    },
    {
      id: "codex-browser",
      label: "Codex built-in browser",
      available: false,
      reason:
        "T3 has no supported adapter to the Codex desktop app's built-in browser and its separate profile.",
      transport: "desktop-host",
      profile: "codex-browser",
    },
    {
      id: "codex-computer-use",
      label: "Codex desktop Computer Use",
      available: false,
      reason:
        "T3 has no supported adapter to the Codex desktop Computer Use host, app approvals, and foreground input ownership.",
      transport: "desktop-host",
      profile: "desktop",
    },
  ];
}
