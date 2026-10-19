import { describe, expect, it } from "vite-plus/test";
import { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { codexDesktopSettings } from "./codexDesktopSettings.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const settings = (providerInstances: unknown) => decodeSettings({ providerInstances });

describe("desktop provider settings", () => {
  it("uses the enabled desktop instance's shared home", () => {
    expect(
      codexDesktopSettings(
        settings({
          ordinary: { driver: "codex", config: { homePath: "/ordinary" } },
          desktop: { driver: "codex", config: { useDesktopAppDaemon: true, homePath: "/desktop" } },
        }),
      ),
    ).toMatchObject({ enabled: true, homePath: "/desktop", useDesktopAppDaemon: true });
  });
  it("honors disable flags on the instance and config", () => {
    expect(
      codexDesktopSettings(
        settings({
          first: { driver: "codex", enabled: false, config: { useDesktopAppDaemon: true } },
          second: { driver: "codex", config: { enabled: false, useDesktopAppDaemon: true } },
        }),
      ).enabled,
    ).toBe(false);
  });
  it("keeps the native default home when no valid desktop instance exists", () => {
    expect(
      codexDesktopSettings(
        settings({ broken: { driver: "codex", config: { useDesktopAppDaemon: "invalid" } } }),
      ),
    ).toMatchObject({ enabled: false, homePath: "" });
  });
});
