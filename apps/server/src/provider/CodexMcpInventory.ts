import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";
import { redactCodexSensitiveText } from "./CodexAppServerTransport.ts";
// `toolsAndAuthOnly` omits resource arrays, although the generated full-response schema requires them.
const CodexMcpServerStatusPageSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      authStatus: EffectCodexSchema.V2ListMcpServerStatusResponse__McpAuthStatus,
      name: Schema.String,
      tools: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  nextCursor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});
const decodeCodexMcpServerStatusPage = Schema.decodeUnknownEffect(CodexMcpServerStatusPageSchema);

const requestCodexMcpServerStatusPage = Effect.fn("requestCodexMcpServerStatusPage")(function* (
  client: {
    readonly raw: {
      readonly request: (
        method: "mcpServerStatus/list",
        params: EffectCodexSchema.V2ListMcpServerStatusParams,
      ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
    };
  },
  params: EffectCodexSchema.V2ListMcpServerStatusParams,
) {
  return yield* client.raw.request("mcpServerStatus/list", params).pipe(
    Effect.flatMap((response) => decodeCodexMcpServerStatusPage(response)),
    Effect.mapError((error) =>
      Schema.isSchemaError(error)
        ? CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
            "decode-response-payload",
            error,
            { method: "mcpServerStatus/list" },
          )
        : error,
    ),
  );
});

type CodexMcpServerStartupStatus = EffectCodexSchema.V2McpServerStatusUpdatedNotification["status"];

export interface CodexThreadMcpInventory {
  readonly servers: ReadonlyArray<{
    readonly name: string;
    readonly startupStatus: CodexMcpServerStartupStatus | "unknown";
    readonly authStatus: EffectCodexSchema.V2ListMcpServerStatusResponse__McpAuthStatus;
    readonly toolCount: number;
  }>;
  readonly hasCuaRepl: boolean;
  readonly hasNodeRepl: boolean;
  readonly omittedServers: boolean;
}

const CODEX_THREAD_MCP_INVENTORY_LIMIT = 40;
const CODEX_INVENTORY_CONTROL_CHARS = /\p{Cc}/gu;

export const readCodexThreadMcpInventory = Effect.fn("readCodexThreadMcpInventory")(function* (
  client: {
    readonly raw: {
      readonly request: (
        method: "mcpServerStatus/list",
        params: EffectCodexSchema.V2ListMcpServerStatusParams,
      ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
    };
  },
  threadId: string,
  startupStatuses: ReadonlyMap<string, CodexMcpServerStartupStatus>,
): Effect.fn.Return<CodexThreadMcpInventory, CodexErrors.CodexAppServerError> {
  const servers: CodexThreadMcpInventory["servers"][number][] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let hasCuaRepl = false;
  let hasNodeRepl = false;
  let omittedServers = false;

  do {
    const page = yield* requestCodexMcpServerStatusPage(client, {
      threadId,
      detail: "toolsAndAuthOnly",
      limit: CODEX_THREAD_MCP_INVENTORY_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    for (const server of page.data) {
      hasCuaRepl ||= server.name === "cua_repl";
      hasNodeRepl ||= server.name === "node_repl";
      if (servers.length >= CODEX_THREAD_MCP_INVENTORY_LIMIT) {
        omittedServers = true;
        continue;
      }
      servers.push({
        name: server.name.replace(CODEX_INVENTORY_CONTROL_CHARS, " ").slice(0, 80),
        startupStatus: startupStatuses.get(server.name) ?? "unknown",
        authStatus: server.authStatus,
        toolCount: Object.keys(server.tools).length,
      });
    }

    cursor = page.nextCursor ?? undefined;
    if (cursor && seenCursors.has(cursor)) {
      omittedServers = true;
      break;
    }
    if (cursor) seenCursors.add(cursor);
    if (servers.length === CODEX_THREAD_MCP_INVENTORY_LIMIT && cursor) {
      omittedServers = true;
    }
  } while (cursor);

  return {
    servers,
    hasCuaRepl,
    hasNodeRepl,
    omittedServers,
  };
});

export function formatCodexThreadMcpInventory(inventory: CodexThreadMcpInventory): string {
  const servers =
    inventory.servers.length === 0
      ? "none reported"
      : inventory.servers
          .map(
            (server) =>
              `${server.name} (startup ${server.startupStatus}, auth ${server.authStatus}, ${server.toolCount} tools)`,
          )
          .join("; ");
  const omitted = inventory.omittedServers ? "; additional servers omitted" : "";
  return `MCP servers attached to this thread: ${servers}${omitted}. cua_repl ${inventory.hasCuaRepl ? "present" : "absent"}; node_repl ${inventory.hasNodeRepl ? "present" : "absent"}.`;
}

export function formatCodexAppServerReadFailure(
  error: CodexErrors.CodexAppServerError,
  secrets: ReadonlyArray<string> = [],
): string {
  const detail =
    error._tag === "CodexAppServerRequestError"
      ? `request code ${error.code}: ${error.errorMessage}`
      : `${error._tag}: ${error.message}`;
  return redactCodexSensitiveText(detail, secrets)
    .replace(CODEX_INVENTORY_CONTROL_CHARS, " ")
    .slice(0, 240);
}
