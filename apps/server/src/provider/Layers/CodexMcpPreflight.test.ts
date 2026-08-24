import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  CODEX_MCP_PREFLIGHT_TIMEOUT_MS,
  codexMcpDisableOverride,
  collectCodexHttpMcpServers,
  probeCodexHttpMcp,
  preflightCodexMcpServers,
  sanitizeCodexMcpEndpoint,
  validateCodexMcpEndpoint,
} from "./CodexMcpPreflight.ts";

describe("Codex MCP preflight", () => {
  const inheritedConfig = `
[mcp_servers.healthy]
url = "https://healthy.example.test/mcp"

[mcp_servers.dead]
url = "https://dead.example.test/mcp"

[mcp_servers.slow]
url = "https://slow.example.test/mcp"

[mcp_servers.local]
command = "python"
args = ["server.py"]

[mcp_servers."t3-code"]
url = "http://127.0.0.1:3774/mcp"
`;

  const publicAddresses = async () => ["93.184.216.34"];

  it("probes HTTP MCPs, excludes dead endpoints, and preserves healthy/T3/stdio servers", async () => {
    const configBefore = inheritedConfig;
    const probed: string[] = [];
    const result = await preflightCodexMcpServers({
      configTexts: [{ source: "config.toml", text: inheritedConfig }],
      appServerArgs: ["-c", 'mcp_servers."t3-code".url=http://127.0.0.1:3774/mcp'],
      probe: async (url) => {
        probed.push(url);
        return url.includes("dead")
          ? { reachable: false, reason: "connection-failed" as const }
          : { reachable: true as const };
      },
      resolveHost: publicAddresses,
    });

    NodeAssert.deepStrictEqual(probed.toSorted(), [
      "https://dead.example.test/mcp",
      "https://healthy.example.test/mcp",
      "https://slow.example.test/mcp",
    ]);
    NodeAssert.deepStrictEqual(result.disabledServerNames, ["dead"]);
    NodeAssert.deepStrictEqual(result.unavailable, [
      {
        kind: "codex.mcp.unavailable",
        serverName: "dead",
        endpoint: "https://dead.example.test/mcp",
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
        return url.includes("slow")
          ? { reachable: false, reason: "timeout" as const }
          : { reachable: true as const };
      },
      resolveHost: publicAddresses,
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
        { name: "healthy", url: "https://healthy.example.test/mcp" },
        { name: "dead", url: "https://dead.example.test/mcp" },
        { name: "slow", url: "https://slow.example.test/mcp" },
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

  it("lets the nearest project config override the global and parent entries", () => {
    NodeAssert.deepStrictEqual(
      collectCodexHttpMcpServers({
        configTexts: [
          {
            source: "CODEX_HOME/config.toml",
            text: '[mcp_servers.audit]\nurl = "https://global.example.test/mcp"',
          },
          {
            source: "repo/.codex/config.toml",
            text: '[mcp_servers.audit]\nurl = "https://parent.example.test/mcp"',
          },
          {
            source: "repo/project/.codex/config.toml",
            text: '[mcp_servers.audit]\nurl = "https://nearest.example.test/mcp"',
          },
        ],
      }),
      [{ name: "audit", url: "https://nearest.example.test/mcp" }],
    );
  });

  it("blocks private, metadata, and DNS-resolved private endpoints before probing", async () => {
    const probed: string[] = [];
    const result = await preflightCodexMcpServers({
      configTexts: [
        {
          source: "config.toml",
          text: `
[mcp_servers.loopback]
url = "http://127.0.0.1:31001/mcp"

[mcp_servers.metadata]
url = "http://169.254.169.254/latest/meta-data"

[mcp_servers.rebound]
url = "https://rebound.example.test/mcp"
`,
        },
      ],
      probe: async (url) => {
        probed.push(url);
        return { reachable: true };
      },
      resolveHost: async (hostname) =>
        hostname === "rebound.example.test" ? ["10.0.0.8"] : ["93.184.216.34"],
    });

    NodeAssert.deepStrictEqual(probed, []);
    NodeAssert.deepStrictEqual(
      result.unavailable.map(({ serverName, reason }) => ({ serverName, reason })),
      [
        { serverName: "loopback", reason: "blocked" },
        { serverName: "metadata", reason: "blocked" },
        { serverName: "rebound", reason: "blocked" },
      ],
    );
  });

  it("trusts only the exact T3-owned name for local MCP endpoints", async () => {
    NodeAssert.equal(
      validateCodexMcpEndpoint("t3-code", "http://127.0.0.1:3774/mcp").allowed,
      true,
    );
    NodeAssert.equal(validateCodexMcpEndpoint("other", "http://127.0.0.1:3774/mcp").allowed, false);
    NodeAssert.equal(validateCodexMcpEndpoint("other", "http://[::1]:3774/mcp").allowed, false);
    NodeAssert.equal(
      validateCodexMcpEndpoint("t3-code", "http://127.0.0.1:3774/admin").allowed,
      false,
    );

    let probed = false;
    await preflightCodexMcpServers({
      configTexts: [
        {
          source: "config.toml",
          text: '[mcp_servers."t3-code"]\nurl = "http://127.0.0.1:3774/mcp"',
        },
      ],
      probe: async () => {
        probed = true;
        return { reachable: true };
      },
    });
    NodeAssert.equal(
      probed,
      false,
      "the injected T3 endpoint is intentionally excluded from inherited probes",
    );
  });

  it("redacts endpoint credentials, queries, and fragments from diagnostics", () => {
    NodeAssert.equal(
      sanitizeCodexMcpEndpoint("https://user:secret@example.test/mcp?token=abc#fragment"),
      "https://example.test/mcp",
    );
  });

  it("does not follow redirects and consumes only a bounded response body", async () => {
    let receivedInit: RequestInit | undefined;
    const result = await probeCodexHttpMcp("https://example.test/mcp", 100, {
      fetchImpl: async (_input, init) => {
        receivedInit = init;
        return new Response("x".repeat(8_192), {
          status: 302,
          headers: { Location: "http://127.0.0.1/" },
        });
      },
    });

    NodeAssert.deepStrictEqual(result, {
      reachable: false,
      reason: "redirected",
      detail: "Redirects are not followed.",
    });
    NodeAssert.equal(receivedInit?.redirect, "manual");

    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4_096));
      },
      cancel() {
        canceled = true;
      },
    });
    NodeAssert.deepStrictEqual(
      await probeCodexHttpMcp("https://example.test/mcp", 100, {
        fetchImpl: async () => new Response(body, { status: 200 }),
      }),
      { reachable: true },
    );
    NodeAssert.equal(canceled, true);
  });
});
