import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexError from "../errors.ts";
import { makeTerminationError } from "./stdio.ts";

describe("Codex App Server child process termination", () => {
  it.effect("retains the process identifier with the exit code", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(51),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9)),
      });

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.pid, 51);
      assert.equal(error.code, 9);
      assert.equal(error.message, "Codex App Server process exited with code 9");
    }),
  );

  it.effect("preserves sanitized stderr and the active request context", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(53),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        },
        { method: "config/read", requestId: "7" },
        {
          stderr: "setup error token=[REDACTED]",
          stderrTruncated: true,
        },
      );

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.method, "config/read");
      assert.equal(error.requestId, "7");
      assert.equal(error.stderr, "setup error token=[REDACTED]");
      assert.equal(error.stderrTruncated, true);
      assert.include(error.message, "config/read");
      assert.include(error.message, "setup error token=[REDACTED]");
      assert.notInclude(error.message, "secret-value");
    }),
  );

  it.effect("retains the process identifier and exact exit-status cause", () =>
    Effect.gen(function* () {
      const rootCause = new Error("private process diagnostics");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: rootCause,
      });
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(52),
        exitCode: Effect.fail(cause),
      });

      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.pid, 52);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Codex App Server transport operation 'read-process-exit-status' failed.",
      );
      assert.notInclude(error.message, rootCause.message);
    }),
  );
});
