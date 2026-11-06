import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as McpClient from "effect/ai/McpClient";
import { McpClientError, ProtocolError, TransportError } from "effect/ai/McpClientError";
import {
  configuredCodexCatalogConnector,
  ensureCodexCatalogStartup,
  verifyCatalog,
} from "./CodexCatalogStartup.ts";

const unavailable = () =>
  new McpClientError({
    reason: new ProtocolError({
      code: -32000,
      description:
        "Otis tool catalog unavailable. Retry tools/list; discovery will notify when the gateway recovers.",
    }),
  });

it.live("catalog startup warms the configured stdio connector before returning", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const script = path.join(directory, "otis-ssh.mjs");
    const source = yield* fs.readFileString(
      path.join(import.meta.dirname, "testFixtures", "catalog-startup", "otis-ssh.mjs.txt"),
    );
    yield* fs.writeFileString(script, source);
    yield* ensureCodexCatalogStartup({
      environment: process.env,
      configTexts: [
        {
          source: "fixture",
          text: `[mcp_servers.otis]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([script, "fixture-transport.json"])}\n`,
        },
      ],
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])("catalog startup retries are bounded and recover=%s", (recover) =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<void>();
    const second = yield* Deferred.make<void>();
    let calls = 0;
    const client = {
      listTools: () =>
        Effect.gen(function* () {
          calls++;
          if (calls === 1) yield* Deferred.succeed(first, undefined);
          if (calls === 2) yield* Deferred.succeed(second, undefined);
          if (calls === 3 && recover) return [];
          return yield* unavailable();
        }),
    } as unknown as McpClient.McpClient;
    const fiber = yield* verifyCatalog().pipe(
      Effect.provideService(McpClient.McpClient, client),
      Effect.forkChild,
    );
    yield* Deferred.await(first);
    yield* TestClock.adjust("250 millis");
    assert.equal(calls, 2);
    yield* Deferred.await(second);
    yield* TestClock.adjust("500 millis");
    assert.equal(Exit.isSuccess(yield* Fiber.await(fiber)), recover);
    assert.equal(calls, 3);
  }),
);

it.effect.each([
  new McpClientError({
    reason: new TransportError({ description: "Connection ended after sending" }),
  }),
  new McpClientError({ reason: new ProtocolError({ code: -32000, description: "Unauthorized" }) }),
])("catalog startup does not replay other failures, %s", (error) =>
  Effect.gen(function* () {
    let calls = 0;
    const client = {
      listTools: () =>
        Effect.suspend(() => {
          calls++;
          return Effect.fail(error);
        }),
    } as unknown as McpClient.McpClient;
    const result = yield* verifyCatalog().pipe(
      Effect.provideService(McpClient.McpClient, client),
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(result));
    assert.equal(calls, 1);
  }),
);

it("catalog startup follows inherited exact connector settings without guessing other servers", () => {
  const config = {
    text: `[mcp_servers.otis]
command = '/usr/bin/node'
args = [
  '/home/user/.otis-client/otis-ssh.mjs',
  '/home/user/.otis-client/transport.json',
]
[mcp_servers.otis.env]
EXAMPLE_SETTING = 'private-test-value'
`,
  };
  assert.deepEqual(configuredCodexCatalogConnector([config]), {
    command: "/usr/bin/node",
    args: ["/home/user/.otis-client/otis-ssh.mjs", "/home/user/.otis-client/transport.json"],
    env: { EXAMPLE_SETTING: "private-test-value" },
  });
  assert.isUndefined(
    configuredCodexCatalogConnector([config, { text: "[mcp_servers.otis]\nenabled = false" }]),
  );
  assert.isUndefined(
    configuredCodexCatalogConnector([
      config,
      { text: "[mcp_servers.otis]\nurl = 'https://example.test/mcp'" },
    ]),
  );
  assert.isUndefined(
    configuredCodexCatalogConnector([{ text: config.text.replace("otis-ssh.mjs", "other.mjs") }]),
  );
  assert.throws(() =>
    configuredCodexCatalogConnector([{ text: "[mcp_servers.otis]\nargs = [123]" }]),
  );
});
