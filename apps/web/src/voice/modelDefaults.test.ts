import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { initialCallModels } from "./modelDefaults";
import { deriveProviderInstanceEntries } from "../providerInstances";
import type { CallModels, ModelSelection } from "@t3tools/contracts";

function catalog(providers: readonly ServerProvider[], hidden: readonly string[] = []) {
  return {
    instanceEntries: deriveProviderInstanceEntries(providers),
    modelOptionsByInstance: new Map(
      providers.map((entry) => [
        entry.instanceId,
        entry.models.filter((model) => !hidden.includes(model.slug)),
      ]),
    ),
  };
}

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
      catalog([voice, operator]),
      {
        instanceId: operator.instanceId,
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
    );
    expect(models.voice.instanceId).toBe("voice-ready");
    expect(models.operator).toEqual({
      instanceId: operator.instanceId,
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  });
  it.each(["voice", "operator"] as const)(
    "resolves a hidden %s through saved defaults, global default, then visible catalog",
    (role) => {
      const base = provider("codex", "codex", "gpt-6.1-sol");
      const luna = { ...base.models[0]!, slug: "gpt-6-luna" };
      const entry = { ...base, models: [...base.models, luna, { ...luna, slug: "gpt-5.6-sol" }] };
      const visible = catalog([entry], ["gpt-5.6-sol"]);
      const hidden: ModelSelection = {
        instanceId: entry.instanceId,
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      const saved: ModelSelection = { instanceId: entry.instanceId, model: "gpt-6-luna" };
      const global: ModelSelection = {
        instanceId: entry.instanceId,
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "medium" }],
      };
      const pair = (selection: ModelSelection): CallModels => ({
        voice: selection,
        operator: selection,
      });
      expect(
        initialCallModels([entry], hidden, visible, global, pair(hidden), pair(saved))[role],
      ).toEqual(saved);
      expect(
        initialCallModels([entry], hidden, visible, global, pair(hidden), pair(hidden))[role],
      ).toEqual(global);
      expect(
        initialCallModels([entry], hidden, visible, hidden, pair(hidden), pair(hidden))[role],
      ).toEqual({ instanceId: entry.instanceId, model: "gpt-6.1-sol" });
      expect(
        initialCallModels([entry], hidden, visible, global, pair(saved), pair(global))[role],
      ).toEqual(saved);
    },
  );
  it("does not select hidden preferred voice models or an empty catalog", () => {
    const voice = provider("voice", "claudeAgent", "claude-haiku-5-5");
    const operator = provider("codex", "codex", "gpt-6.1-sol");
    const current = { instanceId: voice.instanceId, model: "hidden-composer" };
    expect(
      initialCallModels(
        [voice, operator],
        current,
        catalog([voice, operator], ["claude-haiku-5-5"]),
      ).voice,
    ).toEqual({ instanceId: operator.instanceId, model: "gpt-6.1-sol" });
    expect(
      initialCallModels([voice], current, catalog([voice], ["claude-haiku-5-5"])).voice.model,
    ).toBe("");
  });
});
