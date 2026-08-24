// @effect-diagnostics nodeBuiltinImport:off - Tests use an isolated temporary filesystem fixture.
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import * as Effect from "effect/Effect";
import { assert, describe, it } from "@effect/vitest";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  codexDenyReadAclStatePath,
  inspectCodexDenyReadAclState,
  isCorruptDenyReadAclStateBytes,
  isConfirmedCorruptCodexSandboxExit,
  quarantineCorruptCodexDenyReadAclState,
  shouldRecoverCodexSandboxExit,
  withCodexSandboxStartupRecovery,
} from "./CodexSandboxRecovery.ts";

const makeHome = () => Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-codex-recovery-"));
const writeState = (home: string, content: Uint8Array) => {
  const path = codexDenyReadAclStatePath(home);
  Fs.mkdirSync(Path.dirname(path), { recursive: true });
  Fs.writeFileSync(path, content);
  return path;
};

describe("Codex Windows sandbox state recovery", () => {
  it("recognizes only an all-NUL state file as corruption", () => {
    assert.equal(isCorruptDenyReadAclStateBytes(new Uint8Array(22)), true);
    assert.equal(isCorruptDenyReadAclStateBytes(new TextEncoder().encode("{}")), false);
    assert.equal(isCorruptDenyReadAclStateBytes(new Uint8Array()), false);
  });

  it.effect("quarantines the exact state file without deleting its contents", () =>
    Effect.acquireUseRelease(
      Effect.sync(makeHome),
      (home) =>
        Effect.gen(function* () {
          const path = writeState(home, new Uint8Array(22));
          assert.deepEqual(inspectCodexDenyReadAclState(home, "win32"), {
            path,
            status: "corrupt",
          });

          const quarantine = yield* quarantineCorruptCodexDenyReadAclState({
            homeDirectory: home,
            platform: "win32",
          });
          assert.exists(quarantine);
          assert.equal(Fs.existsSync(path), false);
          assert.deepEqual(
            [...Fs.readFileSync(quarantine.quarantinedPath)],
            [...new Uint8Array(22)],
          );
          assert.equal(Path.dirname(quarantine.quarantinedPath), Path.dirname(path));
        }),
      (home) => Effect.sync(() => Fs.rmSync(home, { recursive: true, force: true })),
    ),
  );

  it("rejects unsafe and unrelated exits", () => {
    const exit = new CodexErrors.CodexAppServerProcessExitedError({
      code: 1,
      stderr: "configuration rejected",
    });
    assert.equal(isConfirmedCorruptCodexSandboxExit(exit), false);
    assert.equal(shouldRecoverCodexSandboxExit(exit, Os.homedir()), false);
    assert.equal(inspectCodexDenyReadAclState(Os.homedir(), "linux").status, "unsafe");
  });

  it("recognizes the confirmed stderr marker before allowing recovery", () => {
    const exit = new CodexErrors.CodexAppServerProcessExitedError({
      code: 1,
      stderr:
        "parse deny-read ACL state deny_read_acl_state.json: expected value at line 1 column 1",
    });
    assert.equal(isConfirmedCorruptCodexSandboxExit(exit), true);
  });

  it.effect("retries exactly once for the confirmed corruption and never for another exit", () =>
    Effect.acquireUseRelease(
      Effect.sync(makeHome),
      (home) =>
        Effect.gen(function* () {
          writeState(home, new Uint8Array(22));
          const confirmedExit = new CodexErrors.CodexAppServerProcessExitedError({
            code: 1,
            stderr:
              "parse deny-read ACL state deny_read_acl_state.json: expected value at line 1 column 1",
          });
          let confirmedAttempts = 0;
          const recovered = yield* withCodexSandboxStartupRecovery({
            homeDirectory: home,
            run: () => {
              confirmedAttempts += 1;
              return confirmedAttempts === 1
                ? Effect.fail(confirmedExit)
                : Effect.succeed("recovered");
            },
          });
          assert.equal(recovered, "recovered");
          assert.equal(confirmedAttempts, 2);

          writeState(home, new Uint8Array(22));
          let unrelatedAttempts = 0;
          const unrelatedExit = new CodexErrors.CodexAppServerProcessExitedError({
            code: 1,
            stderr: "configuration rejected",
          });
          const unrelated = yield* withCodexSandboxStartupRecovery({
            homeDirectory: home,
            run: () => {
              unrelatedAttempts += 1;
              return Effect.fail(unrelatedExit);
            },
          }).pipe(Effect.flip);
          assert.strictEqual(unrelated, unrelatedExit);
          assert.equal(unrelatedAttempts, 1);
        }),
      (home) => Effect.sync(() => Fs.rmSync(home, { recursive: true, force: true })),
    ),
  );
});
