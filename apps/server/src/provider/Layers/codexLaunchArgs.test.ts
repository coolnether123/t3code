import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  parseCodexConfigOverrides,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe("parseCodexConfigOverrides", () => {
  it("converts supported config and feature flags into a thread config map", () => {
    NodeAssert.deepStrictEqual(
      parseCodexConfigOverrides([
        "-c",
        "model=gpt-5.3-codex",
        "--config=temperature=0.2",
        "--enable",
        "web_search",
        "--disable=multi_agent",
        "-c",
        'servers=["one", "two"]',
        "-c",
        "use_legacy_landlock=true",
      ]),
      {
        _tag: "success",
        config: {
          model: "gpt-5.3-codex",
          temperature: 0.2,
          "features.web_search": true,
          "features.multi_agent": false,
          servers: ["one", "two"],
          "features.use_legacy_landlock": true,
        },
      },
    );
  });

  it("reports unsupported proxy flags and malformed overrides", () => {
    NodeAssert.deepStrictEqual(parseCodexConfigOverrides(["--strict-config"]), {
      _tag: "failure",
      argument: "--strict-config",
      reason: "the daemon proxy has no per-thread equivalent for this flag",
    });
    NodeAssert.deepStrictEqual(parseCodexConfigOverrides(["-c", "missing-value"]), {
      _tag: "failure",
      argument: "missing-value",
      reason: "it must use key=value syntax",
    });
    NodeAssert.deepStrictEqual(parseCodexConfigOverrides(["--config", "-c"]), {
      _tag: "failure",
      argument: "--config",
      reason: "it requires a following key=value argument",
    });
  });
});
