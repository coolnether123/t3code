// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - The standalone launchd entrypoint owns a short-lived Codex subprocess outside the server runtime.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  appendCodexQuotaSampleFile,
  codexWeeklyQuotaSample,
  resolveCodexQuotaRequestTimeoutMs,
  type CodexRateLimitsResponse,
} from "../src/usage/codexQuotaSampler.ts";

const REQUEST_TIMEOUT_MS = resolveCodexQuotaRequestTimeoutMs(
  process.env.T3CODE_QUOTA_REQUEST_TIMEOUT_MS,
);
const CLIENT_INFO = {
  clientInfo: { name: "t3-quota-sampler", title: "T3 quota sampler", version: "1" },
  capabilities: { experimentalApi: true, optOutNotificationMethods: null },
};

interface RpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

export function requestCodexRpc(
  child: ChildProcessWithoutNullStreams,
  id: number,
  method: string,
  params: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Codex did not answer ${method} within ${timeoutMs} ms.`));
    }, timeoutMs);
    const lines = createInterface({ input: child.stdout });
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `Codex app-server exited before ${method} completed (code ${code ?? "unknown"}).`,
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      lines.close();
      child.off("exit", onExit);
      child.off("error", onError);
    };
    lines.on("line", (line) => {
      let response: RpcResponse;
      try {
        response = JSON.parse(line) as RpcResponse;
      } catch {
        cleanup();
        reject(new Error("Codex app-server returned malformed JSON-RPC output."));
        return;
      }
      if (response.id !== id) return;
      cleanup();
      if (response.error) reject(new Error(response.error.message ?? `${method} failed.`));
      else resolve(response.result);
    });
    child.once("exit", onExit);
    child.once("error", onError);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (!error) return;
      cleanup();
      reject(error);
    });
  });
}

function rpcNotification(
  child: ChildProcessWithoutNullStreams,
  method: string,
  params: unknown,
): void {
  child.stdin.write(`${JSON.stringify({ method, params })}\n`);
}

/** Make one authenticated quota read without creating a thread or starting a turn. */
export async function readCodexRateLimits(binaryPath = process.env.CODEX_BINARY_PATH || "codex") {
  const environment = { ...process.env };
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;
  const child = spawn(binaryPath, ["app-server"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  try {
    await requestCodexRpc(child, 1, "initialize", CLIENT_INFO);
    rpcNotification(child, "initialized", {});
    return (await requestCodexRpc(
      child,
      2,
      "account/rateLimits/read",
      {},
    )) as CodexRateLimitsResponse;
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    const detail = error instanceof Error ? error.message : "Codex quota read failed.";
    throw new Error(stderr.trim() ? `${detail} ${stderr.trim()}` : detail, { cause: error });
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

export async function collectCodexQuotaSample(options: {
  readonly binaryPath?: string;
  readonly statePath: string;
  readonly now?: () => Date;
  readonly readRateLimits?: (binaryPath?: string) => Promise<CodexRateLimitsResponse>;
}): Promise<boolean> {
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const response = await (options.readRateLimits ?? readCodexRateLimits)(options.binaryPath);
  const sample = codexWeeklyQuotaSample(response, observedAt);
  if (!sample)
    throw new Error(
      "Codex did not report a valid weekly quota window; history was left unchanged.",
    );
  await appendCodexQuotaSampleFile(options.statePath, sample, observedAt);
  return true;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  const statePath =
    process.env.T3CODE_QUOTA_HISTORY_PATH ||
    join(homedir(), "Library", "Application Support", "CodexLimits", "state.json");
  collectCodexQuotaSample({ statePath }).then(
    () => process.stdout.write("Codex weekly quota sample saved.\n"),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Quota sampling failed."}\n`,
      );
      process.exitCode = 1;
    },
  );
}
