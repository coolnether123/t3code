import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  buildTurnStartParams,
  formatCodexAppServerReadFailure,
  formatCodexThreadMcpInventory,
  readCodexThreadMcpInventory,
} from "./CodexSessionRuntime.ts";

describe("Codex desktop MCP inventory", () => {
  it("accepts toolsAndAuthOnly pages without resource arrays and reports cua_repl", () => {
    const server = {
      name: "cua_repl",
      authStatus: "bearerToken" as const,
      tools: { "agent.browsers.list": {}, "agent.browsers.open": {} },
    };
    const calls: Array<EffectCodexSchema.V2ListMcpServerStatusParams> = [];
    const client = {
      raw: {
        request: (
          _method: "mcpServerStatus/list",
          params: EffectCodexSchema.V2ListMcpServerStatusParams,
        ) => {
          calls.push(params);
          return Effect.succeed({ data: [server], nextCursor: null });
        },
      },
    };

    const inventory = Effect.runSync(
      readCodexThreadMcpInventory(client, "provider-thread", new Map()),
    );

    expect(calls).toEqual([{ threadId: "provider-thread", detail: "toolsAndAuthOnly", limit: 40 }]);
    expect(inventory).toEqual({
      servers: [
        { name: "cua_repl", startupStatus: "unknown", authStatus: "bearerToken", toolCount: 2 },
      ],
      hasCuaRepl: true,
      hasNodeRepl: false,
      omittedServers: false,
    });
    const summary = formatCodexThreadMcpInventory(inventory);
    expect(summary).toContain("MCP servers attached to this thread:");
    expect(summary).toContain("cua_repl present; node_repl absent");
  });

  it("retains daemon read diagnostics without leaking MCP credentials", () => {
    const credential = "fake-daemon-session-token";
    const authorization = `Bearer ${credential}`;
    const error = new CodexErrors.CodexAppServerRequestError({
      code: -32601,
      errorMessage: `Method not found: mcpServerStatus/list\n${authorization}`,
    });

    const diagnostic = formatCodexAppServerReadFailure(error, [authorization, credential]);

    expect(diagnostic).toContain("request code -32601: Method not found: mcpServerStatus/list");
    expect(diagnostic).not.toContain(credential);
    expect(diagnostic).not.toContain("Bearer");
    expect(diagnostic).not.toMatch(/[\u0000-\u001f\u007f]/u);
  });

  it("passes desktop-daemon browser guidance into native turn instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-desktop-daemon",
        runtimeMode: "full-access",
        interactionMode: "default",
        useDesktopAppDaemon: true,
      }),
    );
    const instructions = params.collaborationMode?.settings.developer_instructions ?? "";

    expect(instructions).toContain("Codex Chrome browser-extension route");
    expect(instructions).toContain("Do not substitute Sky");
    expect(instructions).not.toContain("Configured Windows Computer Use");
  });
});
