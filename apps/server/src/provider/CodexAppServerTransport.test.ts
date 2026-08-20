import { describe, expect, it } from "@effect/vitest";

import {
  codexAppServerCommandArgs,
  codexAppServerTransport,
  macDesktopCodexBinaryCandidates,
} from "./CodexAppServerTransport.ts";

describe("CodexAppServerTransport", () => {
  it("uses the managed daemon proxy only when the desktop bridge is enabled", () => {
    expect(codexAppServerTransport({ useDesktopAppDaemon: false })).toBe("stdio");
    expect(codexAppServerTransport({ useDesktopAppDaemon: true })).toBe("desktop-daemon");
  });

  it("places existing app-server overrides after the selected subcommand", () => {
    const overrides = ["-c", 'mcp_servers.t3-code.url="http://127.0.0.1"'];
    expect(codexAppServerCommandArgs("stdio", overrides)).toEqual(["app-server", ...overrides]);
    expect(codexAppServerCommandArgs("desktop-daemon", overrides)).toEqual([
      "app-server",
      "proxy",
      ...overrides,
    ]);
  });

  it("prefers the Codex app bundle while retaining the ChatGPT compatibility paths", () => {
    expect(macDesktopCodexBinaryCandidates("/Users/christinesmith")).toEqual([
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Users/christinesmith/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Users/christinesmith/Applications/ChatGPT.app/Contents/Resources/codex",
    ]);
  });
});
