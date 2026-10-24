import * as HostProcess from "@t3tools/shared/HostProcess";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** Runs a fixture's POSIX shell scripts on Windows without changing the simulated provider OS. */
export const makePosixFixtureSpawner = Effect.fn("test.makePosixFixtureSpawner")(function* (
  fixtureRoot: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  if (!(yield* HostProcess.isWindows)) return spawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const nativeTar = cliArchiveTarCommand("win32", environment);
  const git = yield* resolveCommandPath("git");
  const candidates =
    git === null
      ? []
      : [
          path.resolve(path.dirname(git), "../bin/bash.exe"),
          path.resolve(path.dirname(git), "../usr/bin/bash.exe"),
          path.resolve(path.dirname(git), "../../usr/bin/bash.exe"),
        ];
  const bash = yield* Effect.findFirst(candidates, (candidate) => fs.exists(candidate));
  const root = path.resolve(fixtureRoot).toLowerCase() + path.sep;
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (
        command._tag === "StandardCommand" &&
        command.command === "tar" &&
        command.args.some((arg) => path.resolve(arg).toLowerCase().startsWith(root))
      ) {
        return yield* spawner.spawn(ChildProcess.make(nativeTar, command.args, command.options));
      }
      if (
        command._tag !== "StandardCommand" ||
        !path.resolve(command.command).toLowerCase().startsWith(root)
      ) {
        return yield* spawner.spawn(command);
      }
      const source = yield* fs.readFileString(command.command).pipe(Effect.orElseSucceed(() => ""));
      if (!/^#!\/(?:bin\/(?:ba)?sh|usr\/bin\/env (?:ba)?sh)(?:\r?\n|$)/.test(source)) {
        return yield* spawner.spawn(command);
      }
      if (Option.isNone(bash))
        return yield* Effect.die(
          new Error("Git for Windows Bash is required for POSIX executable fixtures."),
        );
      return yield* spawner.spawn(
        ChildProcess.make(
          bash.value,
          ["--noprofile", "--norc", "--", command.command.replaceAll("\\", "/"), ...command.args],
          {
            ...command.options,
            shell: false,
            env: { ...command.options.env, BASH_ENV: "", ENV: "" },
          },
        ),
      );
    }),
  );
});
