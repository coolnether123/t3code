import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveSidebarEnvironmentScope } from "./useSidebarEnvironmentScope";

const elora = EnvironmentId.make("elora");
const millie = EnvironmentId.make("millie");

describe("sidebar environment scope", () => {
  it("defaults to the primary Mac, with a deliberate combined option", () => {
    expect(resolveSidebarEnvironmentScope(null, elora, [elora, millie])).toBe(elora);
    expect(resolveSidebarEnvironmentScope("all", elora, [elora, millie])).toBeNull();
  });

  it("retains a saved remote choice and falls back when that connection disappears", () => {
    expect(resolveSidebarEnvironmentScope(millie, elora, [elora, millie])).toBe(millie);
    expect(resolveSidebarEnvironmentScope(millie, elora, [elora])).toBe(elora);
  });
});
