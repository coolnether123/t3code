import { describe, expect, it } from "vite-plus/test";

import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";

const runtime = { model: "gpt-5.6-sol", reasoningEffort: "high" } as const;

describe("Codex browser provider instructions", () => {
  it("does not infer a managed browser from the selected mode", () => {
    for (const computerControlMode of ["chrome", "desktop"] as const) {
      const instructions = buildCodexDeveloperInstructions(
        "default",
        { ...runtime, computerControlMode },
        false,
      );
      expect(instructions).not.toContain("computer_start");
      expect(instructions).not.toContain("preview_status");
      expect(instructions).not.toMatch(
        /@oai\/sky|mcp__node_repl__js|explicitly trusts|unrestricted/,
      );
    }
  });

  it("describes only the discovered managed Chrome tools and their separate profile", () => {
    const instructions = buildCodexDeveloperInstructions(
      "default",
      { ...runtime, computerControlMode: "chrome", computerControlAvailable: true },
      false,
    );
    expect(instructions).toMatch(
      /computer_start.*computer_status.*computer_tabs.*computer_select_tab/s,
    );
    expect(instructions).toMatch(/computer_navigate.*computer_snapshot.*computer_click/s);
    expect(instructions).toMatch(/computer_fill.*computer_type.*computer_close/s);
    expect(instructions).toContain("separate persistent Chrome profile");
    expect(instructions).toContain("Tool availability is not an approval");
    expect(instructions).toContain("Opening a URL does not provide observation or input control");
    expect(instructions).not.toContain("preview_status");
  });

  it("makes the saved desktop preference's browser-only fallback explicit", () => {
    const instructions = buildCodexDeveloperInstructions(
      "default",
      { ...runtime, computerControlMode: "desktop", computerControlAvailable: true },
      false,
    );
    expect(instructions).toContain("does not attach Codex desktop Computer Use to T3");
    expect(instructions).toContain("browser-only fallback");
    expect(instructions).toContain("independently configured MCP server");
    expect(instructions).not.toMatch(/Full Windows and Chrome control|@oai\/sky|explicitly trusts/);
  });

  it("keeps preview mode independent from managed Chrome availability", () => {
    const instructions = buildCodexDeveloperInstructions(
      "default",
      { ...runtime, computerControlMode: "preview", computerControlAvailable: true },
      true,
    );
    expect(instructions).toContain("preview_status");
    expect(instructions).not.toContain("computer_start");
    expect(instructions).not.toContain("Desktop control availability");
  });

  it("does not describe managed tools when capability discovery reports them absent", () => {
    const instructions = buildCodexDeveloperInstructions(
      "plan",
      { ...runtime, computerControlMode: "chrome", computerControlAvailable: false },
      true,
    );
    expect(instructions).toContain("preview_status");
    expect(instructions).not.toContain("computer_start");
  });
});
