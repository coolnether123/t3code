import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkCodexProviderStatus } from "./CodexProvider.ts";

/**
 * Stand-in for Codex 0.162's catalog: `model/list` answers from a fresh
 * `CODEX_HOME/models_cache.json`; the startup refresh runs before `initialize`
 * with the spawn originator (override env var, else `codex_cli_rs`); Ultrafast
 * is granted only to entitled accounts on app originators.
 */
const FAKE_CODEX_APP_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
if (process.argv.includes("proxy")) {
  const socket = require("node:net").connect(Number(process.env.FAKE_DAEMON_PORT), "127.0.0.1");
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
} else {
const cachePath = path.join(process.env.CODEX_HOME, "models_cache.json");
const originator = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "codex_cli_rs";
const ultrafast = process.env.FAKE_ULTRAFAST_ENTITLED === "1" && originator !== "codex_cli_rs";
const model = (tiers) => ({
  id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "",
  hidden: false, isDefault: true, defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
  serviceTiers: tiers.map((id) => ({ id, name: id, description: "" })),
});
setTimeout(() => {
  const tiers = ultrafast ? ["priority", "ultrafast"] : ["priority"];
  fs.writeFileSync(cachePath, JSON.stringify({ fetched_at: new Date().toISOString(), models: [model(tiers)] }));
}, 300);
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    write({ id, result: { userAgent: "codex/0.162.0", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" } });
  } else if (method === "account/read") {
    write({ id, result: { account: { type: "chatgpt", email: "test@example.com", planType: "promax" }, requiresOpenaiAuth: false } });
  } else if (method === "skills/list") {
    write({ id, result: { data: [] } });
  } else if (method === "model/list") {
    write({ id, result: { data: JSON.parse(fs.readFileSync(cachePath, "utf8")).models, nextCursor: null } });
  } else {
    write({ id, error: { code: -32601, message: "unsupported" } });
  }
});
}
`;

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const solServiceTiers = Effect.fn("solServiceTiers")(function* (
  ultrafastEntitled: boolean,
  desktopDaemon = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-catalog-" });
  const platform = yield* HostProcess.Platform;
  const binaryPath = path.join(dir, platform === "win32" ? "codex.cmd" : "codex");
  if (platform === "win32") {
    const scriptPath = path.join(dir, "codex.cjs");
    const node = yield* HostProcess.ExecutablePath;
    yield* fs.writeFileString(scriptPath, FAKE_CODEX_APP_SERVER);
    yield* fs.writeFileString(binaryPath, `@echo off\r\n"${node}" "${scriptPath}" %*\r\n`);
  } else {
    yield* fs.writeFileString(binaryPath, FAKE_CODEX_APP_SERVER);
  }
  yield* fs.chmod(binaryPath, 0o755);

  const daemonMethods: string[] = [];
  let daemonPort: number | undefined;
  if (desktopDaemon) {
    const server = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeSocket.NodeWS.WebSocketServer>((resolve, reject) => {
            const server = new NodeSocket.NodeWS.WebSocketServer({ port: 0 });
            server.once("listening", () => resolve(server));
            server.once("error", reject);
          }),
      ),
      (server) => Effect.sync(() => server.close()),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Synthetic daemon did not expose a TCP address");
    }
    daemonPort = address.port;
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const { id, method } = JSON.parse(data.toString());
        daemonMethods.push(method);
        if (id === undefined) return;
        const result =
          method === "initialize"
            ? {
                userAgent: "codex/0.157.1",
                codexHome: dir,
                platformFamily: "windows",
                platformOs: "windows",
              }
            : method === "account/read"
              ? {
                  account: { type: "chatgpt", email: "test@example.com", planType: "promax" },
                  requiresOpenaiAuth: false,
                }
              : method === "skills/list"
                ? {
                    data: [
                      {
                        cwd: process.cwd(),
                        errors: [],
                        skills: [
                          {
                            name: "daemon-skill",
                            description: "Synthetic daemon skill",
                            path: "/synthetic/skill",
                            enabled: true,
                            scope: "user",
                          },
                        ],
                      },
                    ],
                  }
                : { data: [], nextCursor: null };
        socket.send(JSON.stringify({ id, result }));
      });
    });
  }

  yield* fs.writeFileString(
    path.join(dir, "models_cache.json"),
    JSON.stringify({
      fetched_at: DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 1 })),
      models: [
        {
          id: "gpt-6.1-sol",
          model: "gpt-6.1-sol",
          displayName: "GPT-6.1 Sol",
          description: "",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
          serviceTiers: (ultrafastEntitled ? ["priority"] : ["priority", "ultrafast"]).map(
            (id) => ({ id, name: id, description: "" }),
          ),
        },
      ],
    }),
  );

  const { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: _ambient, ...environment } = process.env;
  const provider = yield* checkCodexProviderStatus(
    decodeCodexSettings({
      binaryPath,
      homePath: desktopDaemon ? path.join(dir, "unused-configured-home") : dir,
      useDesktopAppDaemon: desktopDaemon,
    }),
    undefined,
    {
      ...environment,
      FAKE_ULTRAFAST_ENTITLED: ultrafastEntitled ? "1" : "0",
      ...(daemonPort ? { FAKE_DAEMON_PORT: String(daemonPort) } : {}),
    },
  );
  if (desktopDaemon) {
    assert.include(daemonMethods, "account/read");
    assert.include(daemonMethods, "skills/list");
    assert.notInclude(daemonMethods, "model/list");
    assert.deepStrictEqual(
      provider.skills.map((skill) => skill.name),
      ["daemon-skill"],
    );
  }
  const serviceTier = provider.models
    .find((model) => model.slug === "gpt-6.1-sol")
    ?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "serviceTier");
  return serviceTier?.type === "select" ? serviceTier.options.map((option) => option.id) : [];
});

it.layer(NodeServices.layer, { excludeTestServices: true })("Codex catalog discovery", (it) => {
  it.effect(
    "discovers Sol with the current CLI while keeping account and skills on the daemon",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* solServiceTiers(true, true), [
          "default",
          "priority",
          "ultrafast",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps Ultrafast when another Codex client wrote the shared catalog cache", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* solServiceTiers(true), ["default", "priority", "ultrafast"]);
    }).pipe(Effect.scoped),
  );

  it.effect("drops Ultrafast once the account is no longer entitled to it", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* solServiceTiers(false), ["default", "priority"]);
    }).pipe(Effect.scoped),
  );
});
