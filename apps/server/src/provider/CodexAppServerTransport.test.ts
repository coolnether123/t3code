import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import {
  codexAppServerCommandArgs,
  codexAppServerTransport,
  codexDesktopDaemonEnvironment,
  codexDesktopDaemonRepairMessage,
  codexManagedCliPath,
  ensureCodexDesktopDaemonStarted,
  redactCodexProtocolLogEvent,
  makeCodexDesktopDaemonStdio,
  macDesktopCodexBinaryCandidates,
  resolveCodexBinaryPath,
} from "./CodexAppServerTransport.ts";

describe("CodexAppServerTransport", () => {
  it("uses the managed daemon proxy only when the desktop bridge is enabled", () => {
    expect(codexAppServerTransport({ useDesktopAppDaemon: false })).toBe("stdio");
    expect(codexAppServerTransport({ useDesktopAppDaemon: true })).toBe("desktop-daemon");
  });

  it("keeps launch args for stdio and uses only the proxy command for desktop daemon", () => {
    const overrides = ["-c", 'mcp_servers.t3-code.url="http://127.0.0.1"'];
    expect(codexAppServerCommandArgs("stdio", overrides)).toEqual(["app-server", ...overrides]);
    expect(codexAppServerCommandArgs("desktop-daemon", overrides)).toEqual(["app-server", "proxy"]);
  });

  it("uses the host Codex home and ignores a provider-instance Codex home", () => {
    expect(
      codexDesktopDaemonEnvironment(
        { CODEX_HOME: "/tmp/provider-home", PATH: "/tmp/provider-bin" },
        { codex_home: "/Users/host/.codex", HOME: "/Users/host" },
      ),
    ).toEqual({ CODEX_HOME: "/Users/host/.codex", PATH: "/tmp/provider-bin" });
  });

  it("directs daemon repairs to the standalone managed Codex CLI", () => {
    const message = codexDesktopDaemonRepairMessage("could not reach the daemon control socket");
    expect(message).toContain("standalone managed Codex CLI");
    expect(message).toContain("app-server daemon bootstrap");
    expect(message).toContain("app-server daemon version");
  });

  it("redacts the T3 MCP authorization header from serialized protocol logs", () => {
    const credential = "fake-desktop-session-token";
    const event = {
      direction: "outgoing",
      stage: "decoded",
      payload: JSON.stringify({
        method: "thread/start",
        params: {
          config: {
            "mcp_servers.t3-code.http_headers": {
              Authorization: `Bearer ${credential}`,
            },
          },
        },
      }),
    } as const;

    const logged = JSON.stringify(redactCodexProtocolLogEvent(event, [credential]));
    expect(logged).not.toContain(credential);
    expect(logged).toContain("[REDACTED]");
  });

  it("prefers the Codex app bundle while retaining the ChatGPT compatibility paths", () => {
    expect(macDesktopCodexBinaryCandidates("/Users/christinesmith")).toEqual([
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Users/christinesmith/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Users/christinesmith/Applications/ChatGPT.app/Contents/Resources/codex",
    ]);
  });

  it.effect("resolves the managed Windows CLI for a desktop-backed provider", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const codexHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-home-" });
      const binary = path.join(codexHome, "packages", "standalone", "current", "bin", "codex.exe");
      yield* fileSystem.makeDirectory(path.dirname(binary), { recursive: true });
      yield* fileSystem.writeFileString(binary, "");

      const resolved = yield* resolveCodexBinaryPath(
        { binaryPath: "codex", useDesktopAppDaemon: true },
        { CODEX_HOME: codexHome },
      );
      expect(resolved).toBe(binary);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcessPlatform, "win32"),
    ),
  );

  it.effect("upgrades the desktop proxy byte tunnel and exchanges masked WebSocket messages", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const server = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeSocket.NodeWS.WebSocketServer>((resolve, reject) => {
              const instance = new NodeSocket.NodeWS.WebSocketServer({ port: 0 });
              instance.once("listening", () => resolve(instance));
              instance.once("error", reject);
            }),
        ),
        (instance) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                instance.close(() => resolve());
              }),
          ),
      );
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("WebSocket test server did not expose a TCP address");
      }

      const receivedMessages: Array<string> = [];
      const receivedBinaryFlags: Array<boolean> = [];
      server.on("connection", (socket) => {
        socket.on("message", (data, isBinary) => {
          receivedMessages.push(data.toString());
          receivedBinaryFlags.push(isBinary);
          socket.send('{"id":1,"result":{"ok":true}}');
        });
      });

      const proxyScript = [
        "const net = require('node:net');",
        "const socket = net.connect(Number(process.argv[1]), '127.0.0.1');",
        "process.stdin.pipe(socket);",
        "socket.pipe(process.stdout);",
        "socket.on('error', (error) => { console.error(error); process.exitCode = 1; });",
      ].join(" ");
      const proxy = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["-e", proxyScript, String(address.port)]),
      );
      const stdio = yield* makeCodexDesktopDaemonStdio(proxy);

      yield* Stream.make('{"id":1,"method":"initialize"}\n').pipe(Stream.run(stdio.stdout()));
      const responseChunks = yield* stdio.stdin.pipe(Stream.take(1), Stream.runCollect);

      expect(receivedMessages).toEqual(['{"id":1,"method":"initialize"}']);
      expect(receivedBinaryFlags).toEqual([false]);
      expect(Array.from(responseChunks, (chunk) => new TextDecoder().decode(chunk))).toEqual([
        '{"id":1,"result":{"ok":true}}\n',
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("ensureCodexDesktopDaemonStarted", () => {
  const recordingSpawner = (commands: Array<ReadonlyArray<string>>) =>
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const input = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
        };
        commands.push([input.command, ...input.args]);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
  const withCodexHome = (
    run: (
      codexHome: string,
      commands: Array<ReadonlyArray<string>>,
    ) => Effect.Effect<
      void,
      PlatformError.PlatformError,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) => {
    const commands: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const codexHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-home-" });
      yield* run(codexHome, commands);
    }).pipe(
      Effect.scoped,
      Effect.orDie,
      Effect.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner(commands)).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  };

  it.effect(
    "starts the managed daemon from the package entrypoint when its socket is missing",
    () =>
      withCodexHome((codexHome, commands) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const packageRoot = path.join(codexHome, "packages", "standalone", "current");
          yield* fileSystem.makeDirectory(packageRoot, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(packageRoot, "codex-package.json"),
            '{"entrypoint":"bin/codex"}',
          );
          yield* ensureCodexDesktopDaemonStarted({ CODEX_HOME: codexHome });
          expect(commands).toEqual([
            [path.join(packageRoot, "bin/codex"), "app-server", "daemon", "start"],
          ]);
          expect(yield* codexManagedCliPath(path.join(codexHome, "missing"), "darwin")).toBe(
            path.join(codexHome, "missing", "packages", "standalone", "current", "codex"),
          );
        }),
      ),
  );

  it.effect("uses the Windows standalone bin fallback when a package manifest is absent", () =>
    withCodexHome((codexHome, commands) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* ensureCodexDesktopDaemonStarted({ CODEX_HOME: codexHome });
        expect(commands).toEqual([
          [
            path.join(codexHome, "packages", "standalone", "current", "bin", "codex.exe"),
            "app-server",
            "daemon",
            "start",
          ],
        ]);
      }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
    ),
  );

  it.effect("does nothing while the daemon control socket exists", () =>
    withCodexHome((codexHome, commands) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(codexHome, "app-server-control"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(codexHome, "app-server-control", "app-server-control.sock"),
          "",
        );
        yield* ensureCodexDesktopDaemonStarted({ CODEX_HOME: codexHome });
        expect(commands).toEqual([]);
      }),
    ),
  );
});
