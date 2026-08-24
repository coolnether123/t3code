import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  CODEX_MCP_PREFLIGHT_TIMEOUT_MS,
  codexMcpDisableOverride,
  collectCodexHttpMcpServers,
  preflightCodexMcpServers,
} from "./CodexMcpPreflight.ts";

describe("Codex MCP preflight", () => {
  const inheritedConfig = `
[mcp_servers.healthy]
url = "http://127.0.0.1:31001/mcp"

[mcp_servers.dead]
url = "http://127.0.0.1:31002/mcp"

[mcp_servers.slow]
url = "http://127.0.0.1:31003/mcp"

[mcp_servers.local]
command = "python"
args = ["server.py"]

[mcp_servers."t3-code"]
url = "http://127.0.0.1:3774/mcp"
`;

  it("probes HTTP MCPs, excludes dead endpoints, and preserves healthy/T3/stdio servers", async () => {
    const configBefore = inheritedConfig;
    const probed: string[] = [];
    const result = await preflightCodexMcpServers({
      configTexts: [{ source: "config.toml", text: inheritedConfig }],
      appServerArgs: ["-c", 'mcp_servers."t3-code".url=http://127.0.0.1:3774/mcp'],
      probe: async (url) => {
        probed.push(url);
        return url.includes("31002")
          ? { reachable: false, reason: "connection-failed" as const }
          : { reachable: true as const };
      },
    });

    NodeAssert.deepStrictEqual(probed.toSorted(), [
      "http://127.0.0.1:31001/mcp",
      "http://127.0.0.1:31002/mcp",
      "http://127.0.0.1:31003/mcp",
    ]);
    NodeAssert.deepStrictEqual(result.disabledServerNames, ["dead"]);
    NodeAssert.deepStrictEqual(result.unavailable, [
      {
        kind: "codex.mcp.unavailable",
        serverName: "dead",
        endpoint: "http://127.0.0.1:31002/mcp",
        reason: "connection-failed",
        timeoutMs: CODEX_MCP_PREFLIGHT_TIMEOUT_MS,
      },
    ]);
    NodeAssert.equal(inheritedConfig, configBefore);
  });

  it("reports a bounded timeout as one named diagnostic", async () => {
    const result = await preflightCodexMcpServers({
      configTexts: [{ source: "config.toml", text: inheritedConfig }],
      probe: async (url, timeoutMs) => {
        NodeAssert.equal(timeoutMs, CODEX_MCP_PREFLIGHT_TIMEOUT_MS);
        return url.includes("31003")
          ? { reachable: false, reason: "timeout" as const }
          : { reachable: true as const };
      },
    });

    NodeAssert.deepStrictEqual(result.disabledServerNames, ["slow"]);
    NodeAssert.equal(result.unavailable[0]?.kind, "codex.mcp.unavailable");
    NodeAssert.equal(result.unavailable[0]?.serverName, "slow");
  });

  it("does not classify local stdio MCPs or the injected T3 endpoint as HTTP servers", () => {
    NodeAssert.deepStrictEqual(
      collectCodexHttpMcpServers({
        configTexts: [{ source: "config.toml", text: inheritedConfig }],
      }),
      [
        { name: "healthy", url: "http://127.0.0.1:31001/mcp" },
        { name: "dead", url: "http://127.0.0.1:31002/mcp" },
        { name: "slow", url: "http://127.0.0.1:31003/mcp" },
      ],
    );
  });

  it("creates session-scoped disable overrides without changing config.toml", () => {
    NodeAssert.equal(codexMcpDisableOverride("dead"), "mcp_servers.dead.enabled=false");
    NodeAssert.equal(
      codexMcpDisableOverride("server.with.dots"),
      'mcp_servers."server.with.dots".enabled=false',
    );
  });
});
