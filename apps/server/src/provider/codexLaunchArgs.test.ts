import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexMcpListLaunchArgs,
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
  it.each([
    {
      name: "preserves escaped TOML quotes in config values",
      launchArgs: String.raw`--config model=\"gpt-6.1-sol\" --strict-config`,
      expected: ["--config", 'model="gpt-6.1-sol"', "--strict-config"],
    },
    {
      name: "lets launch args override the unload delay",
      launchArgs: "-c thread_unload_delay_secs=1800",
      expected: ["-c", "thread_unload_delay_secs=1800"],
    },
  ])("asks Codex to unload unsubscribed threads immediately and $name", (row) => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(row.launchArgs), [
      "app-server",
      "-c",
      "thread_unload_delay_secs=0",
      ...row.expected,
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

describe("codex exec and mcp list launch args", () => {
  const launchArgs =
    "--strict-config --oss --local-provider ollama --profile local -p=work --listen off --enable foo";

  it("keeps the local model provider flags for codex exec", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs(launchArgs), [
      "--strict-config",
      "--oss",
      "--local-provider",
      "ollama",
      "--profile",
      "local",
      "-p=work",
      "--enable",
      "foo",
    ]);
  });

  it("keeps the selected profile and drops exec-only flags for codex mcp list", () => {
    NodeAssert.deepStrictEqual(codexMcpListLaunchArgs(launchArgs), [
      "--profile",
      "local",
      "-p=work",
      "--enable",
      "foo",
    ]);
  });
});
