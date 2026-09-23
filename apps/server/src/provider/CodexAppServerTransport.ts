import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type { CodexSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexErrors from "effect-codex-app-server/errors";

export type CodexAppServerTransport = "stdio" | "desktop-daemon";

const CODEX_DESKTOP_DAEMON_WS_URL = "ws://localhost/";
const CODEX_DESKTOP_DAEMON_HANDSHAKE_TIMEOUT_MS = 10_000;

type DesktopDaemonChildProcess = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "pid" | "stdin" | "stdout"
>;

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const toTransportError = (
  operation: CodexErrors.CodexAppServerTransportOperation,
  pid: ChildProcessSpawner.ProcessId,
  cause: unknown,
) => new CodexErrors.CodexAppServerTransportError({ operation, pid, cause });

const textEncoder = new TextEncoder();

const toMessageText = (data: NodeSocket.NodeWS.WebSocket.RawData): string => {
  const decoder = new TextDecoder();
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return decoder.decode(data);
  if (data instanceof ArrayBuffer) return decoder.decode(new Uint8Array(data));

  const size = data.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of data) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(output);
};

/**
 * Adapts `codex app-server proxy` to the line-oriented app-server client.
 *
 * The desktop proxy exposes the daemon's Unix WebSocket as a raw byte stream
 * on its own stdin/stdout. `ws` owns the HTTP Upgrade and WebSocket framing;
 * this adapter translates WebSocket message boundaries to the line-oriented
 * Effect child-process streams.
 */
export const makeCodexDesktopDaemonStdio = Effect.fn("makeCodexDesktopDaemonStdio")(function* (
  child: DesktopDaemonChildProcess,
): Effect.fn.Return<Stdio.Stdio, CodexErrors.CodexAppServerTransportError, Scope.Scope> {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const outgoingTextDecoder = new TextDecoder();
  const childInput = yield* Queue.unbounded<Uint8Array>();
  let bridge: NodeStream.Duplex | undefined;

  const childInputFiber = Stream.fromQueue(childInput).pipe(
    Stream.run(child.stdin),
    Effect.tapError((cause) =>
      Effect.sync(() => {
        bridge?.destroy(toError(cause));
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* childInputFiber;

  bridge = new NodeStream.Duplex({
    read() {
      // The stdout pump below pushes bytes as the proxy produces them.
    },
    write(chunk, _encoding, callback) {
      runFork(
        Queue.offer(childInput, new Uint8Array(chunk)).pipe(
          Effect.match({
            onFailure: (cause) => callback(toError(cause)),
            onSuccess: () => callback(),
          }),
        ),
      );
    },
    destroy(cause, callback) {
      runFork(Queue.shutdown(childInput));
      callback(cause === null ? undefined : toError(cause));
    },
  });
  // `ws` installs its own socket error listener during the HTTP upgrade, but
  // the bridge can be destroyed while that upgrade is being interrupted.
  // Keep a listener for the cleanup race so a late stream error cannot become
  // an uncaught Node exception.
  bridge.on("error", () => undefined);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      bridge?.destroy();
    }),
  );

  yield* child.stdout.pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        if (!bridge?.destroyed) bridge.push(chunk);
      }),
    ),
    Effect.tapError((cause) =>
      Effect.sync(() => {
        bridge?.destroy(toError(cause));
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (bridge && !bridge.destroyed) bridge.push(null);
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  let socket: NodeSocket.NodeWS.WebSocket | undefined;
  let handshakeOpen: (() => void) | undefined;
  let handshakeError: ((cause: unknown) => void) | undefined;
  let handshakeClose: (() => void) | undefined;
  let handshakeSettled = false;
  const terminateSocket = () => {
    if (socket && socket.readyState !== NodeSocket.NodeWS.WebSocket.CLOSED) {
      socket.terminate();
    }
    bridge?.destroy();
  };
  const removeHandshakeListeners = () => {
    if (handshakeOpen) socket?.off("open", handshakeOpen);
    if (handshakeClose) socket?.off("close", handshakeClose);
    // Keep the error guard attached through socket termination. `ws` may emit
    // a deferred error after the other listeners and bridge have been closed.
  };

  // Register this before starting the asynchronous upgrade. A failed or
  // interrupted upgrade must close the socket and bridge even when the
  // handshake callback never resumes successfully.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      removeHandshakeListeners();
      terminateSocket();
    }),
  );

  const websocket = yield* Effect.callback<
    NodeSocket.NodeWS.WebSocket,
    CodexErrors.CodexAppServerTransportError
  >((resume) => {
    const failOpen = (cause: unknown) => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      terminateSocket();
      resume(Effect.fail(toTransportError("read-input-stream", child.pid, cause)));
    };
    handshakeError = failOpen;
    handshakeClose = () => failOpen(new Error("Desktop daemon WebSocket closed during handshake"));
    handshakeOpen = () => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      // The socket is now the live transport. Do not close it here; the
      // enclosing scope finalizer owns teardown after the client is built.
      resume(Effect.succeed(socket!));
    };
    try {
      socket = new NodeSocket.NodeWS.WebSocket(CODEX_DESKTOP_DAEMON_WS_URL, {
        createConnection: (() => bridge!) as unknown as typeof NodeNet.createConnection,
        handshakeTimeout: CODEX_DESKTOP_DAEMON_HANDSHAKE_TIMEOUT_MS,
        perMessageDeflate: false,
      });
      // Keep the error/close listeners attached through the transition from
      // handshake to the live transport. A bridge teardown can otherwise emit
      // a late error between callback completion and the live listeners below.
      socket.on("open", handshakeOpen);
      socket.on("error", handshakeError);
      socket.on("close", handshakeClose);
    } catch (cause) {
      failOpen(cause);
    }
    return Effect.sync(() => {
      if (!handshakeSettled) {
        handshakeSettled = true;
        terminateSocket();
      }
    });
  });

  const incoming = yield* Queue.unbounded<Uint8Array>();
  const shutdownIncoming = () => {
    runFork(Queue.shutdown(incoming));
  };
  const onMessage = (data: NodeSocket.NodeWS.WebSocket.RawData) => {
    const message = toMessageText(data).replace(/(?:\r\n|\n)$/, "");
    if (message.length === 0) return;
    runFork(Queue.offer(incoming, textEncoder.encode(`${message}\n`)).pipe(Effect.ignore));
  };
  const onError = (cause: Error) => {
    shutdownIncoming();
    bridge?.destroy(cause);
  };
  const onClose = () => {
    shutdownIncoming();
  };
  websocket.on("message", onMessage);
  websocket.on("error", onError);
  websocket.on("close", onClose);

  const sendMessage = (message: string) =>
    Effect.callback<void, PlatformError.PlatformError>((resume) => {
      if (websocket.readyState !== NodeSocket.NodeWS.WebSocket.OPEN) {
        resume(
          Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "CodexDesktopDaemonWebSocket",
              method: "send",
              description: "WebSocket is not open",
            }),
          ),
        );
        return;
      }
      try {
        websocket.send(message, (cause: Error | undefined) =>
          resume(
            cause == null
              ? Effect.void
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "CodexDesktopDaemonWebSocket",
                    method: "send",
                    cause,
                  }),
                ),
          ),
        );
      } catch (cause) {
        resume(
          Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "CodexDesktopDaemonWebSocket",
              method: "send",
              cause,
            }),
          ),
        );
      }
    });

  let outgoingRemainder = "";
  const send = (chunk: string | Uint8Array) =>
    Effect.gen(function* () {
      const text =
        outgoingRemainder +
        (typeof chunk === "string" ? chunk : outgoingTextDecoder.decode(chunk, { stream: true }));
      let start = 0;
      for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
        const message = text.slice(start, newline).replace(/\r$/, "");
        if (message.length > 0) yield* sendMessage(message);
        start = newline + 1;
      }
      outgoingRemainder = text.slice(start);
    });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      websocket.off("message", onMessage);
      websocket.off("error", onError);
      websocket.off("close", onClose);
      shutdownIncoming();
      if (websocket.readyState !== NodeSocket.NodeWS.WebSocket.CLOSED) websocket.terminate();
      bridge?.destroy();
    }),
  );

  return Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromQueue(incoming),
    stdout: () => Sink.forEach((chunk: string | Uint8Array) => send(chunk)),
    stderr: () => Sink.drain,
  });
});

export function codexAppServerTransport(
  settings: Pick<CodexSettings, "useDesktopAppDaemon">,
): CodexAppServerTransport {
  return settings.useDesktopAppDaemon ? "desktop-daemon" : "stdio";
}

export function codexAppServerCommandArgs(
  transport: CodexAppServerTransport,
  appServerArgs: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  return transport === "desktop-daemon"
    ? ["app-server", "proxy"]
    : ["app-server", ...appServerArgs];
}

export function macDesktopCodexBinaryCandidates(homeDirectory: string): ReadonlyArray<string> {
  return [
    "/Applications/Codex.app/Contents/Resources/codex",
    `${homeDirectory}/Applications/Codex.app/Contents/Resources/codex`,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    `${homeDirectory}/Applications/ChatGPT.app/Contents/Resources/codex`,
  ];
}

/**
 * The desktop bridge must use the app-bundled CLI when it is available. That
 * keeps the proxy protocol version aligned with the running desktop daemon.
 * An explicit binary path always wins.
 */
export const resolveCodexBinaryPath = Effect.fn("resolveCodexBinaryPath")(function* (
  settings: Pick<CodexSettings, "binaryPath" | "useDesktopAppDaemon">,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const platform = yield* HostProcessPlatform;
  if (!settings.useDesktopAppDaemon || settings.binaryPath !== "codex" || platform !== "darwin") {
    return settings.binaryPath;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const candidate of macDesktopCodexBinaryCandidates(NodeOS.homedir())) {
    const exists = yield* fileSystem
      .exists(path.normalize(candidate))
      .pipe(Effect.orElseSucceed(() => false));
    if (exists) return path.normalize(candidate);
  }

  return settings.binaryPath;
});
