// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - This is the provider boundary where Codex config and HTTP reachability are inspected.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const CODEX_MCP_PREFLIGHT_TIMEOUT_MS = 750;
const T3_MCP_SERVER_NAME = "t3-code";

export type CodexMcpUnavailableDiagnostic = {
  readonly kind: "codex.mcp.unavailable";
  readonly serverName: string;
  readonly endpoint: string;
  readonly reason: "timeout" | "connection-failed";
  readonly timeoutMs: number;
};

export type CodexMcpPreflightResult = {
  readonly disabledServerNames: ReadonlyArray<string>;
  readonly unavailable: ReadonlyArray<CodexMcpUnavailableDiagnostic>;
};

type ConfigText = {
  readonly source: string;
  readonly text: string;
};

type ConfiguredMcpServer = {
  readonly name: string;
  readonly url: string;
};

type ProbeResult =
  | { readonly reachable: true }
  | { readonly reachable: false; readonly reason: "timeout" | "connection-failed" };

export type CodexMcpPreflightInput = {
  readonly homePath?: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly appServerArgs?: ReadonlyArray<string>;
  readonly configTexts?: ReadonlyArray<ConfigText>;
  readonly probe?: (url: string, timeoutMs: number) => Promise<ProbeResult>;
};

const emptyResult = (): CodexMcpPreflightResult => ({
  disabledServerNames: [],
  unavailable: [],
});

function decodeTomlString(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(0, trimmed.lastIndexOf('"') + 1));
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    return end > 0 ? trimmed.slice(1, end) : undefined;
  }
  return trimmed.split(/\s+#/u, 1)[0]?.trim() || undefined;
}

function parseSectionName(line: string): string | undefined {
  const match = line.match(/^\s*\[mcp_servers\.(?:"((?:\\.|[^"])*)"|([A-Za-z0-9_-]+))\]\s*$/u);
  if (!match) return undefined;
  if (match[1] !== undefined) return decodeTomlString(`"${match[1]}"`);
  return match[2];
}

function parseConfiguredServersFromToml(text: string): ReadonlyArray<ConfiguredMcpServer> {
  const servers = new Map<string, { url: string | undefined; enabled: boolean | undefined }>();
  let currentName: string | undefined;

  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*\[/u.test(line)) {
      currentName = parseSectionName(line);
      continue;
    }
    if (currentName === undefined) continue;

    const keyValue = line.match(/^\s*(url|enabled)\s*=\s*(.*?)\s*(?:#.*)?$/u);
    if (!keyValue) continue;
    const entry = servers.get(currentName) ?? { url: undefined, enabled: undefined };
    if (keyValue[1] === "url") {
      entry.url = decodeTomlString(keyValue[2] ?? "");
    } else {
      entry.enabled = (keyValue[2] ?? "").trim().toLowerCase() !== "false";
    }
    servers.set(currentName, entry);
  }

  return [...servers.entries()].flatMap(([name, entry]) =>
    entry.url !== undefined && entry.enabled !== false && /^https?:\/\//iu.test(entry.url)
      ? [{ name, url: entry.url }]
      : [],
  );
}

function parseConfiguredServersFromArgs(
  appServerArgs: ReadonlyArray<string> | undefined,
): ReadonlyArray<ConfiguredMcpServer> {
  if (appServerArgs === undefined) return [];
  const servers = new Map<string, string>();
  const pattern =
    /mcp_servers\.(?:"((?:\\.|[^"])*)"|([A-Za-z0-9_-]+))\.url\s*=\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|(\S+))/u;
  for (const argument of appServerArgs) {
    const match = argument.match(pattern);
    if (!match) continue;
    const name = match[1] !== undefined ? decodeTomlString(`"${match[1]}"`) : match[2];
    const url = match[3] !== undefined ? decodeTomlString(`"${match[3]}"`) : (match[4] ?? match[5]);
    if (name !== undefined && url !== undefined && /^https?:\/\//iu.test(url)) {
      servers.set(name, url);
    }
  }
  return [...servers.entries()].map(([name, url]) => ({ name, url }));
}

export function collectCodexHttpMcpServers(input: {
  readonly configTexts: ReadonlyArray<ConfigText>;
  readonly appServerArgs?: ReadonlyArray<string>;
}): ReadonlyArray<ConfiguredMcpServer> {
  const servers = new Map<string, ConfiguredMcpServer>();
  for (const server of input.configTexts.flatMap(({ text }) =>
    parseConfiguredServersFromToml(text),
  )) {
    if (server.name !== T3_MCP_SERVER_NAME) servers.set(server.name, server);
  }
  for (const server of parseConfiguredServersFromArgs(input.appServerArgs)) {
    if (server.name !== T3_MCP_SERVER_NAME) servers.set(server.name, server);
  }
  return [...servers.values()];
}

function resolveCodexHomePath(
  input: Pick<CodexMcpPreflightInput, "homePath" | "environment">,
): string {
  const configured = input.homePath?.trim() || input.environment?.CODEX_HOME?.trim();
  if (!configured) return NodePath.join(NodeOS.homedir(), ".codex");
  return configured.startsWith("~")
    ? NodePath.join(NodeOS.homedir(), configured.slice(2))
    : NodePath.resolve(configured);
}

async function readConfigTexts(input: CodexMcpPreflightInput): Promise<ReadonlyArray<ConfigText>> {
  if (input.configTexts !== undefined) return input.configTexts;
  const paths = new Set<string>([NodePath.join(resolveCodexHomePath(input), "config.toml")]);
  if (input.cwd !== undefined) {
    let current = NodePath.resolve(input.cwd);
    while (true) {
      paths.add(NodePath.join(current, ".codex", "config.toml"));
      const parent = NodePath.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return Promise.all(
    [...paths].map(async (path): Promise<ConfigText | undefined> => {
      try {
        return { source: path, text: await NodeFSP.readFile(path, "utf8") };
      } catch {
        return undefined;
      }
    }),
  ).then((texts) => texts.flatMap((text) => (text === undefined ? [] : [text])));
}

async function probeHttpMcp(url: string, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: "HEAD",
      headers: { Accept: "application/json, text/event-stream" },
      signal: controller.signal,
    });
    return { reachable: true };
  } catch (error) {
    return {
      reachable: false,
      reason:
        error instanceof Error && error.name === "AbortError" ? "timeout" : "connection-failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function preflightCodexMcpServers(
  input: CodexMcpPreflightInput,
): Promise<CodexMcpPreflightResult> {
  const servers = collectCodexHttpMcpServers({
    configTexts: await readConfigTexts(input),
    ...(input.appServerArgs !== undefined ? { appServerArgs: input.appServerArgs } : {}),
  });
  if (servers.length === 0) return emptyResult();

  const probe = input.probe ?? probeHttpMcp;
  const results = await Promise.all(
    servers.map(async (server) => ({
      server,
      result: await probe(server.url, CODEX_MCP_PREFLIGHT_TIMEOUT_MS),
    })),
  );
  const unavailable = results.flatMap(({ server, result }) =>
    result.reachable
      ? []
      : [
          {
            kind: "codex.mcp.unavailable" as const,
            serverName: server.name,
            endpoint: server.url,
            reason: result.reason,
            timeoutMs: CODEX_MCP_PREFLIGHT_TIMEOUT_MS,
          },
        ],
  );
  return {
    disabledServerNames: unavailable.map((diagnostic) => diagnostic.serverName),
    unavailable,
  };
}

export function codexMcpDisableOverride(serverName: string): string {
  const key = /^[A-Za-z0-9_-]+$/u.test(serverName) ? serverName : JSON.stringify(serverName);
  return `mcp_servers.${key}.enabled=false`;
}
