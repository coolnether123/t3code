// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - This is the provider boundary where Codex config and HTTP reachability are inspected.
import * as NodeFSP from "node:fs/promises";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const CODEX_MCP_PREFLIGHT_TIMEOUT_MS = 750;
const CODEX_MCP_PREFLIGHT_MAX_BODY_BYTES = 4_096;
const T3_MCP_SERVER_NAME = "t3-code";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);
const METADATA_HOSTNAMES = new Set([
  "169.254.169.254",
  "instance-data.ec2.internal",
  "metadata.google.internal",
  "metadata.azure.internal",
]);

export type CodexMcpUnavailableDiagnostic = {
  readonly kind: "codex.mcp.unavailable";
  readonly serverName: string;
  readonly endpoint: string;
  readonly reason: "blocked" | "redirected" | "timeout" | "connection-failed";
  readonly timeoutMs: number;
  readonly detail?: string;
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
  | {
      readonly reachable: false;
      readonly reason: "blocked" | "redirected" | "timeout" | "connection-failed";
      readonly detail?: string;
    };

type EndpointValidation =
  | { readonly allowed: true; readonly url: URL }
  | { readonly allowed: false; readonly detail: string };

type ResolveHost = (hostname: string) => Promise<ReadonlyArray<string>>;
type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type CodexMcpPreflightInput = {
  readonly homePath?: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly appServerArgs?: ReadonlyArray<string>;
  readonly configTexts?: ReadonlyArray<ConfigText>;
  readonly probe?: (url: string, timeoutMs: number) => Promise<ProbeResult>;
  readonly resolveHost?: ResolveHost;
  readonly fetchImpl?: FetchImpl;
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

function normalizedIp(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, "").toLowerCase();
}

function ipv4IsBlocked(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  const c = parts[2] ?? -1;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6IsBlocked(hostname: string): boolean {
  const normalized = normalizedIp(hostname);
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  ) {
    return true;
  }
  if (/^fe[89a-f][0-9a-f]:/u.test(normalized) || normalized.startsWith("2001:db8:")) {
    return true;
  }
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (mapped !== undefined) return ipv4IsBlocked(mapped);

  const halves = normalized.split("::");
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length > 1 && halves[1] !== "" ? halves[1]!.split(":") : [];
  const groups = [
    ...left,
    ...Array.from({ length: 8 - left.length - right.length }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.slice(0, 5).some((group) => Number.parseInt(group, 16) !== 0) ||
    Number.parseInt(groups[5] ?? "0", 16) !== 0xffff
  ) {
    return false;
  }
  const high = Number.parseInt(groups[6] ?? "0", 16);
  const low = Number.parseInt(groups[7] ?? "0", 16);
  return ipv4IsBlocked(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
}

function isBlockedAddress(address: string): boolean {
  const normalized = normalizedIp(address);
  const family = NodeNet.isIP(normalized);
  return family === 4
    ? ipv4IsBlocked(normalized)
    : family === 6
      ? ipv6IsBlocked(normalized)
      : false;
}

function isTrustedLocalT3Endpoint(serverName: string, url: URL): boolean {
  if (serverName !== T3_MCP_SERVER_NAME || url.protocol !== "http:") return false;
  if (url.pathname !== "/mcp") return false;
  const hostname = normalizedIp(url.hostname);
  return (
    LOOPBACK_HOSTNAMES.has(hostname) ||
    (NodeNet.isIP(hostname) === 4 && hostname.startsWith("127.")) ||
    (NodeNet.isIP(hostname) === 6 && hostname === "::1")
  );
}

export function validateCodexMcpEndpoint(serverName: string, rawUrl: string): EndpointValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, detail: "The endpoint URL is invalid." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, detail: "Only HTTP and HTTPS MCP endpoints are allowed." };
  }
  if (url.username !== "" || url.password !== "") {
    return { allowed: false, detail: "Endpoint credentials are not allowed." };
  }
  if (METADATA_HOSTNAMES.has(normalizedIp(url.hostname))) {
    return { allowed: false, detail: "Metadata service endpoints are not allowed." };
  }
  if (!isTrustedLocalT3Endpoint(serverName, url)) {
    const hostname = normalizedIp(url.hostname);
    if (
      LOOPBACK_HOSTNAMES.has(hostname) ||
      (NodeNet.isIP(hostname) !== 0 && isBlockedAddress(hostname))
    ) {
      return {
        allowed: false,
        detail: "Private, loopback, link-local, or reserved endpoints are not allowed.",
      };
    }
  }
  return { allowed: true, url };
}

export function sanitizeCodexMcpEndpoint(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid endpoint]";
  }
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
  const paths = [NodePath.join(resolveCodexHomePath(input), "config.toml")];
  const projectPaths: string[] = [];
  if (input.cwd !== undefined) {
    let current = NodePath.resolve(input.cwd);
    while (true) {
      projectPaths.push(NodePath.join(current, ".codex", "config.toml"));
      const parent = NodePath.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  paths.push(...projectPaths.toReversed());

  return Promise.all(
    paths.map(async (path): Promise<ConfigText | undefined> => {
      try {
        return { source: path, text: await NodeFSP.readFile(path, "utf8") };
      } catch {
        return undefined;
      }
    }),
  ).then((texts) => texts.flatMap((text) => (text === undefined ? [] : [text])));
}

async function resolveHostAddresses(hostname: string): Promise<ReadonlyArray<string>> {
  if (NodeNet.isIP(normalizedIp(hostname)) !== 0) return [normalizedIp(hostname)];
  const addresses = await NodeDnsPromises.lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => address);
}

async function consumeBoundedBody(response: Response, maxBytes: number): Promise<void> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  let bytesRead = 0;
  try {
    while (bytesRead < maxBytes) {
      const next = await reader.read();
      if (next.done) return;
      bytesRead += next.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function probeCodexHttpMcp(
  url: string,
  timeoutMs: number,
  options: { readonly fetchImpl?: FetchImpl } = {},
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { Accept: "application/json, text/event-stream" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      if (response.body !== null) await response.body.cancel().catch(() => undefined);
      return { reachable: false, reason: "redirected", detail: "Redirects are not followed." };
    }
    await consumeBoundedBody(response, CODEX_MCP_PREFLIGHT_MAX_BODY_BYTES);
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

  const probe = input.probe ?? ((url, timeoutMs) => probeCodexHttpMcp(url, timeoutMs, input));
  const results = await Promise.all(
    servers.map(async (server) => ({
      server,
      result: await (async (): Promise<ProbeResult> => {
        const endpoint = validateCodexMcpEndpoint(server.name, server.url);
        if (!endpoint.allowed)
          return { reachable: false, reason: "blocked", detail: endpoint.detail };
        if (!isTrustedLocalT3Endpoint(server.name, endpoint.url)) {
          try {
            const resolveHost = input.resolveHost ?? resolveHostAddresses;
            const addresses = await resolveHost(normalizedIp(endpoint.url.hostname));
            if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
              return {
                reachable: false,
                reason: "blocked",
                detail:
                  "The endpoint resolved to a private, loopback, link-local, or reserved address.",
              };
            }
          } catch {
            return {
              reachable: false,
              reason: "connection-failed",
              detail: "DNS resolution failed.",
            };
          }
        }
        return probe(server.url, CODEX_MCP_PREFLIGHT_TIMEOUT_MS);
      })(),
    })),
  );
  const unavailable = results.flatMap(({ server, result }) =>
    result.reachable
      ? []
      : [
          {
            kind: "codex.mcp.unavailable" as const,
            serverName: server.name,
            endpoint: sanitizeCodexMcpEndpoint(server.url),
            reason: result.reason,
            timeoutMs: CODEX_MCP_PREFLIGHT_TIMEOUT_MS,
            ...(result.detail !== undefined ? { detail: result.detail } : {}),
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
