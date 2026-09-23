import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  codexAppServerCommandArgs,
  codexAppServerTransport,
  makeCodexDesktopDaemonStdio,
  macDesktopCodexBinaryCandidates,
} from "./CodexAppServerTransport.ts";
import {
  codexDesktopDaemonSocketPath,
  useCodexDesktopDaemonSocketTransport,
} from "./CodexDesktopDaemonTransport.ts";

describe("CodexAppServerTransport", () => {
  it("uses the managed daemon proxy only when the desktop bridge is enabled", () => {
    expect(codexAppServerTransport({ useDesktopAppDaemon: false })).toBe("stdio");
    expect(codexAppServerTransport({ useDesktopAppDaemon: true })).toBe("desktop-daemon");
  });

  it("keeps overrides for stdio while the desktop proxy receives only its subcommand", () => {
    const overrides = ["-c", 'mcp_servers.t3-code.url="http://127.0.0.1"'];
    expect(codexAppServerCommandArgs("stdio", overrides)).toEqual(["app-server", ...overrides]);
    expect(codexAppServerCommandArgs("desktop-daemon", overrides)).toEqual(["app-server", "proxy"]);
  });

  it("prefers the Codex app bundle while retaining the ChatGPT compatibility paths", () => {
    expect(macDesktopCodexBinaryCandidates("/Users/christinesmith")).toEqual([
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Users/christinesmith/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Users/christinesmith/Applications/ChatGPT.app/Contents/Resources/codex",
    ]);
  });

  it("resolves the managed daemon socket from Codex home and host environment", () => {
    expect(codexDesktopDaemonSocketPath("/tmp/codex-home/")).toBe(
      "/tmp/codex-home/app-server-control/app-server-control.sock",
    );
    expect(
      codexDesktopDaemonSocketPath(undefined, {
        CODEX_HOME: "/tmp/from-codex-home",
        HOME: "/tmp/from-home",
      }),
    ).toBe("/tmp/from-codex-home/app-server-control/app-server-control.sock");
    expect(codexDesktopDaemonSocketPath(undefined, { HOME: "/tmp/from-home" })).toBe(
      "/tmp/from-home/.codex/app-server-control/app-server-control.sock",
    );
    expect(
      codexDesktopDaemonSocketPath("~/.codex-work", {
        HOME: "/tmp/from-home",
      }),
    ).toBe("/tmp/from-home/.codex-work/app-server-control/app-server-control.sock");
    expect(
      codexDesktopDaemonSocketPath(undefined, {
        CODEX_HOME: "~/.codex-work",
        HOME: "/tmp/from-home",
      }),
    ).toBe("/tmp/from-home/.codex-work/app-server-control/app-server-control.sock");
  });

  it("uses the Unix desktop adapter only on macOS", () => {
    expect(useCodexDesktopDaemonSocketTransport("desktop-daemon", "darwin")).toBe(true);
    expect(useCodexDesktopDaemonSocketTransport("desktop-daemon", "win32")).toBe(false);
    expect(useCodexDesktopDaemonSocketTransport("stdio", "darwin")).toBe(false);
  });
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
