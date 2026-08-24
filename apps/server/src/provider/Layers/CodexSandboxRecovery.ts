// @effect-diagnostics nodeBuiltinImport:off - This is a small synchronous boundary for the Windows sandbox state file.
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

const DENY_READ_ACL_STATE_FILE = "deny_read_acl_state.json";
const QUARANTINE_SUFFIX = ".corrupt";

export interface CodexSandboxStateInspection {
  readonly path: string;
  readonly status: "missing" | "valid" | "corrupt" | "unsafe";
}

export interface CodexSandboxStateQuarantine {
  readonly path: string;
  readonly quarantinedPath: string;
}

export function codexDenyReadAclStatePath(homeDirectory = Os.homedir()): string {
  return Path.join(Path.resolve(homeDirectory), ".codex", ".sandbox", DENY_READ_ACL_STATE_FILE);
}

function isSafeStatePath(path: string, homeDirectory: string): boolean {
  const home = Path.resolve(homeDirectory);
  const expectedParent = Path.join(home, ".codex", ".sandbox");
  return Path.dirname(path) === expectedParent && Path.basename(path) === DENY_READ_ACL_STATE_FILE;
}

function hasSafeDirectoryParents(path: string, homeDirectory: string): boolean {
  const home = Path.resolve(homeDirectory);
  const parents = [home, Path.join(home, ".codex"), Path.join(home, ".codex", ".sandbox")];
  return parents.every((parent) => {
    try {
      const stat = Fs.lstatSync(parent);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  });
}

export function isCorruptDenyReadAclStateBytes(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes.every((byte) => byte === 0);
}

export function inspectCodexDenyReadAclState(
  homeDirectory = Os.homedir(),
  platform: string = process.platform,
): CodexSandboxStateInspection {
  const path = codexDenyReadAclStatePath(homeDirectory);
  if (platform !== "win32" || !isSafeStatePath(path, homeDirectory)) {
    return { path, status: "unsafe" };
  }

  let stat: Fs.Stats;
  try {
    stat = Fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, status: "missing" };
    }
    return { path, status: "unsafe" };
  }

  if (!hasSafeDirectoryParents(path, homeDirectory) || !stat.isFile() || stat.isSymbolicLink()) {
    return { path, status: "unsafe" };
  }

  try {
    return {
      path,
      status: isCorruptDenyReadAclStateBytes(Fs.readFileSync(path)) ? "corrupt" : "valid",
    };
  } catch {
    return { path, status: "unsafe" };
  }
}

export function quarantineCorruptCodexDenyReadAclState(
  input: {
    readonly homeDirectory?: string;
    readonly platform?: string;
  } = {},
): Effect.Effect<CodexSandboxStateQuarantine | undefined> {
  const homeDirectory = input.homeDirectory ?? Os.homedir();
  const platform = input.platform ?? process.platform;
  return Effect.try({
    try: () => {
      const inspection = inspectCodexDenyReadAclState(homeDirectory, platform);
      if (inspection.status !== "corrupt") return undefined;

      const parent = Path.dirname(inspection.path);
      const quarantineBase = `${inspection.path}${QUARANTINE_SUFFIX}-${process.pid}`;
      let quarantinedPath = quarantineBase;
      let attempt = 0;
      while (Fs.existsSync(quarantinedPath)) {
        attempt += 1;
        quarantinedPath = `${quarantineBase}-${attempt}`;
      }

      if (Path.dirname(quarantinedPath) !== parent) return undefined;
      Fs.renameSync(inspection.path, quarantinedPath);
      return { path: inspection.path, quarantinedPath } satisfies CodexSandboxStateQuarantine;
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));
}

const isCodexProcessExit = Schema.is(CodexErrors.CodexAppServerProcessExitedError);

export function isConfirmedCorruptCodexSandboxExit(error: unknown): boolean {
  if (!isCodexProcessExit(error) || error.code !== 1) return false;
  const stderr = error.stderr?.toLowerCase() ?? "";
  return (
    stderr.includes("deny_read_acl_state.json") &&
    (stderr.includes("expected value at line 1 column 1") ||
      stderr.includes("parse deny-read acl state"))
  );
}

export function shouldRecoverCodexSandboxExit(
  error: unknown,
  homeDirectory = Os.homedir(),
): boolean {
  return (
    isConfirmedCorruptCodexSandboxExit(error) &&
    inspectCodexDenyReadAclState(homeDirectory).status === "corrupt"
  );
}

export function withCodexSandboxStartupRecovery<A, E, R>(input: {
  readonly run: () => Effect.Effect<A, E, R>;
  readonly homeDirectory?: string;
}): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const first = yield* Effect.result(input.run());
    if (first._tag === "Success") return first.success;
    if (!shouldRecoverCodexSandboxExit(first.failure, input.homeDirectory)) {
      return yield* Effect.fail(first.failure);
    }

    const quarantine = yield* quarantineCorruptCodexDenyReadAclState({
      ...(input.homeDirectory === undefined ? {} : { homeDirectory: input.homeDirectory }),
    });
    if (!quarantine) return yield* Effect.fail(first.failure);
    return yield* input.run();
  });
}
