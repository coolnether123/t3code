import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ChatHeader } from "./ChatHeader";

const state = vi.hoisted(() => ({ developerToolsEnabled: false }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (
    _id: string,
    selector: (settings: typeof DEFAULT_SERVER_SETTINGS) => boolean,
  ) => selector({ ...DEFAULT_SERVER_SETTINGS, developerToolsEnabled: state.developerToolsEnabled }),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "computer-a",
  useEnvironment: (id: string) => ({
    label: id === "computer-a" ? "Example A" : "Example B",
    color: "#123abc",
  }),
}));
vi.mock("../../remoteOpen", () => ({ useRemoteOpenState: () => ({ mode: "remote-links" }) }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("~/hooks/useT3ProjectFileScripts", () => ({ useT3ProjectFileScripts: () => [] }));
vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: vi.fn(), closeMenu: vi.fn() }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { updateMetadata: {} } }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => <span /> }));
vi.mock("../GitActionsControl", () => ({ default: () => <button>Initialize Git</button> }));
vi.mock("../ProjectScriptsControl", () => ({ default: () => <button>Add action</button> }));
vi.mock("./OpenInPicker", () => ({ OpenInPicker: () => <button>Open</button> }));

const props: ComponentProps<typeof ChatHeader> = {
  activeThreadEnvironmentId: EnvironmentId.make("computer-b"),
  activeThreadId: ThreadId.make("example-chat"),
  activeThreadTitle: "Bookkeeping",
  providerRuntimeLabel: "CLI",
  isServerThread: true,
  changeRequest: null,
  activeProjectName: "Workroom",
  activeProjectCwd: "/Users/example/Workroom",
  activeProjectFaviconPath: null,
  openInCwd: "/Users/example/Workroom",
  activeProjectScripts: [],
  preferredScriptId: null,
  keybindings: [],
  availableEditors: [],
  rightPanelOpen: false,
  gitCwd: null,
  transcript: "Synthetic transcript",
  onNewThreadInProject: vi.fn(),
  onRunProjectScript: vi.fn(),
  onAddProjectScript: vi.fn(),
  onUpdateProjectScript: vi.fn(),
  onDeleteProjectScript: vi.fn(),
};

beforeEach(() => {
  state.developerToolsEnabled = false;
});

describe("chat header computer identity", () => {
  it("shows the open chat's computer, not the primary computer, with developer buttons hidden", () => {
    const markup = renderToStaticMarkup(<ChatHeader {...props} />);
    expect(markup).toContain('data-computer-name="Example B"');
    expect(markup).toContain("background-color:#123abc");
    expect(markup).not.toContain('data-computer-name="Example A"');
    for (const label of [
      "Copy chat",
      "Add action",
      "Initialize Git",
      "Task actions",
      "Chat runtime:",
    ]) {
      expect(markup).not.toContain(label);
    }
    expect(markup).not.toContain(">Open<");
    expect(markup).toContain("Bookkeeping");
    expect(markup).toContain("Thread actions for Bookkeeping");
  });

  it("restores desktop and compact header controls with one setting", () => {
    state.developerToolsEnabled = true;
    const markup = renderToStaticMarkup(<ChatHeader {...props} />);
    for (const label of [
      "Copy chat",
      "Add action",
      "Initialize Git",
      "Task actions",
      "Chat runtime:",
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain(">Open<");
    expect(markup).toContain("data-mobile-chat-header-actions");
    expect(markup).toContain("data-chat-header-actions");
    expect(markup).toContain('data-computer-name="Example B"');
  });
});
