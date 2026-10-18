import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { initialCallModels } from "./modelDefaults";

function provider(id: string, driver: string, slug: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName: id,
    enabled: true,
    installed: true,
    version: "synthetic",
    status: "ready",
    availability: "available",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-18T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [
      {
        slug,
        name: slug,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: driver === "codex" ? "reasoningEffort" : "effort",
              label: "Effort",
              type: "select",
              options: [{ id: "medium", label: "Medium" }],
            },
          ],
        },
      },
    ],
  };
}
describe("initial call model preferences", () => {
  it("skips unavailable accounts and accounts without the preferred model", () => {
    const voice = provider("voice-ready", "claudeAgent", "claude-haiku-5-5");
    const operator = provider("operator-ready", "codex", "gpt-6.1-sol");
    const models = initialCallModels(
      [
        {
          ...voice,
          instanceId: ProviderInstanceId.make("voice-offline"),
          availability: "unavailable",
        },
        provider("operator-other", "codex", "other-model"),
        voice,
        operator,
      ],
      { instanceId: voice.instanceId, model: "current" },
    );
    expect(models.voice.instanceId).toBe("voice-ready");
    expect(models.operator).toEqual({
      instanceId: operator.instanceId,
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  });
});
