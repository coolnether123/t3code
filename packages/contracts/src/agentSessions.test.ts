import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { AgentSessionImportInput } from "./agentSessions.ts";

describe("selected session import", () => {
  const decode = Schema.decodeUnknownSync(AgentSessionImportInput);
  it("keeps existing clients compatible", () => {
    expect(decode({ projectId: "project-1" })).toEqual({ projectId: "project-1" });
  });
  it("requires a bounded explicit selection", () => {
    expect(() => decode({ projectId: "project-1", providerSessionIds: [] })).toThrow();
    expect(() =>
      decode({ projectId: "project-1", providerSessionIds: Array(101).fill("session") }),
    ).toThrow();
    expect(
      decode({ projectId: "project-1", providerSessionIds: ["existing-session"] })
        .providerSessionIds,
    ).toEqual(["existing-session"]);
  });
});
