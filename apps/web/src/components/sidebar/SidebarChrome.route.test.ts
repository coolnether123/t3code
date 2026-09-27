import { describe, expect, it } from "vite-plus/test";
import sidebarSource from "./SidebarChrome.tsx?raw";
import routeSource from "../../routeTree.gen.ts?raw";

describe("native Codex chats removal", () => {
  it("has no sidebar action or registered route", () => {
    expect(sidebarSource).not.toContain("Codex chats");
    expect(sidebarSource).not.toContain("handleCodexClick");
    expect(routeSource).not.toContain("'/codex'");
    expect(routeSource).not.toContain("CodexRouteImport");
  });
});
