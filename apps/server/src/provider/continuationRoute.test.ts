import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceConfigMap, ProviderInstanceId, ModelSelection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { resolveContinuationRoute } from "./continuationRoute.ts";

const selection = Schema.decodeUnknownSync(ModelSelection)({
  instanceId: "codex",
  model: "gpt-6.1-sol",
  options: { reasoningEffort: "medium" },
});
const decodeInstances = Schema.decodeUnknownSync(ProviderInstanceConfigMap);
const desktopInstanceId = ProviderInstanceId.make("codex_desktop");
const instances = decodeInstances({
  codex: { driver: "codex", continueThreadsOn: "codex_desktop", config: { enabled: true } },
  codex_desktop: { driver: "codex", config: { enabled: true, useDesktopAppDaemon: true } },
});

describe("Mac continuation routing", () => {
  it("retains the model and options when routing to the desktop instance", () => {
    expect(resolveContinuationRoute(instances, selection)).toEqual({
      ...selection,
      instanceId: "codex_desktop",
    });
  });
  it("leaves ordinary instances unchanged", () => {
    expect(resolveContinuationRoute({}, selection)).toBe(selection);
  });
  it("refuses missing, disabled and cross-driver destinations", () => {
    for (const target of [
      undefined,
      { driver: "codex", enabled: false },
      { driver: "claude", enabled: true },
    ]) {
      const { [desktopInstanceId]: _desktop, ...withoutTarget } = instances;
      const configured = decodeInstances({
        ...withoutTarget,
        ...(target === undefined ? {} : { codex_desktop: target }),
      });
      expect(() => resolveContinuationRoute(configured, selection)).toThrow(
        "Continuation instance",
      );
    }
  });
});
