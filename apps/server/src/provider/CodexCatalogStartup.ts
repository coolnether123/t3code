import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Toml from "effect/encoding/Toml";
import * as McpClient from "effect/ai/McpClient";
import type { McpClientError } from "effect/ai/McpClientError";
import * as McpProtocol from "effect/ai/McpProtocol";
import * as ChildProcess from "effect/process/ChildProcess";
import { readCodexMcpConfigTexts, type CodexMcpPreflightInput } from "./CodexMcpPreflight.ts";

export class CodexCatalogStartupError extends Schema.TaggedError<CodexCatalogStartupError>()(
  "CodexCatalogStartupError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "External tool catalog startup could not be verified. Retry starting the session.";
  }
}

const ConnectorConfig = Schema.Struct({
  command: Schema.optional(Schema.NonEmptyString),
  args: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  enabled: Schema.optional(Schema.Boolean),
  url: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  env_vars: Schema.optional(Schema.Array(Schema.String)),
});
const decodeConnectorConfig = Schema.decodeSync(ConnectorConfig);

export function configuredCodexCatalogConnector(texts: ReadonlyArray<{ readonly text: string }>) {
  const entry: Record<string, unknown> = {};
  for (const { text } of texts) {
    const parsed = Toml.parse(text);
    if (Result.isFailure(parsed)) throw new CodexCatalogStartupError({ cause: parsed.failure });
    const servers = parsed.success.mcp_servers;
    if (!Predicate.isObject(servers) || !Predicate.isObject(servers.otis)) continue;
    const env = Predicate.isObject(servers.otis.env)
      ? { ...(Predicate.isObject(entry.env) ? entry.env : {}), ...servers.otis.env }
      : entry.env;
    Object.assign(entry, servers.otis);
    if (env !== undefined) entry.env = env;
  }
  if (entry.enabled === false || entry.url !== undefined) return undefined;
  const connector = decodeConnectorConfig(entry);
  return connector.command !== undefined &&
    connector.args?.length === 2 &&
    /(?:^|[/\\])otis-ssh\.mjs$/u.test(connector.args[0]!)
    ? { command: connector.command, args: connector.args, env: connector.env }
    : undefined;
}

const catalogUnavailable = (error: McpClientError): boolean =>
  error.reason._tag === "ProtocolError" &&
  error.reason.code === -32000 &&
  error.reason.description ===
    "Otis tool catalog unavailable. Retry tools/list; discovery will notify when the gateway recovers.";

export const verifyCatalog = Effect.fn("CodexCatalogStartup.verify")(function* () {
  const client = yield* McpClient.McpClient;
  yield* client.listTools().pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential("250 millis"),
      while: catalogUnavailable,
    }),
  );
});

export const ensureCodexCatalogStartup = Effect.fn("CodexCatalogStartup.ensure")(function* (
  input: CodexMcpPreflightInput,
) {
  const texts = yield* Effect.tryPromise({
    try: () => readCodexMcpConfigTexts(input),
    catch: (cause) => new CodexCatalogStartupError({ cause }),
  });
  const connector = yield* Effect.try({
    try: () => configuredCodexCatalogConnector(texts),
    catch: (cause) => new CodexCatalogStartupError({ cause }),
  });
  if (connector === undefined) return;
  yield* verifyCatalog().pipe(
    Effect.provide(
      McpClient.layerStdio({
        name: "t3-catalog-startup",
        version: "1",
        timeout: "8 seconds",
        command: ChildProcess.make(connector.command, connector.args, {
          env: { ...input.environment, ...connector.env },
          cwd: input.cwd,
        }),
        protocol: McpProtocol.v2025_11_25,
      }),
    ),
    Effect.scoped,
    Effect.timeout("28 seconds"),
    Effect.mapError((cause) => new CodexCatalogStartupError({ cause })),
  );
});
