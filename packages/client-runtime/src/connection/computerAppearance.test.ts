import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { computerAppearance } from "./computerAppearance.ts";

describe("computer appearance", () => {
  const environmentId = EnvironmentId.make("example-computer");
  const input = { environmentId, fallbackLabel: "Saved connection", serverConfig: null };

  it("uses the computer's name and color instead of a client connection alias", () => {
    expect(
      computerAppearance({
        ...input,
        serverConfig: {
          environment: { label: "Example MacBook Pro" },
          settings: { environmentName: "Example", environmentColor: "#123abc" },
        },
      }),
    ).toEqual({ name: "Example", color: "#123abc" });
  });

  it("uses the host name and a stable color until preferences are set", () => {
    const result = computerAppearance({
      ...input,
      serverConfig: {
        environment: { label: "Example MacBook Pro" },
        settings: { environmentName: "", environmentColor: null },
      },
    });
    expect(result.name).toBe("Example MacBook Pro");
    expect(result.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(result.color).toBe(computerAppearance(input).color);
  });

  it("reflects later broadcasts and resets without changing the computer ID", () => {
    const config = {
      environment: { label: "Example host" },
      settings: { environmentName: "First", environmentColor: "#123abc" },
    };
    expect(computerAppearance({ ...input, serverConfig: config }).name).toBe("First");
    expect(
      computerAppearance({
        ...input,
        serverConfig: {
          ...config,
          settings: { environmentName: "Second", environmentColor: "#654321" },
        },
      }),
    ).toEqual({ name: "Second", color: "#654321" });
    expect(
      computerAppearance({
        ...input,
        serverConfig: { ...config, settings: { environmentName: "", environmentColor: null } },
      }),
    ).toEqual({ name: "Example host", color: computerAppearance(input).color });
  });

  it("has a readable fallback before a computer connects", () => {
    expect(computerAppearance(input).name).toBe("Saved connection");
  });
});
