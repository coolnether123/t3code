import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { UsageSummaryInput } from "./usage.ts";

const decode = Schema.decodeUnknownSync(UsageSummaryInput);
const base = {
  timeZone: "UTC",
  sinceDay: "2026-08-01",
  untilDay: "2026-08-02",
};

describe("UsageSummaryInput", () => {
  it("accepts bounded provider, native session, and native turn selection", () => {
    expect(
      decode({
        ...base,
        providers: ["codex"],
        sessionIds: ["native-session"],
        turnIds: ["native-turn"],
        groupBy: "turn",
        includeRepeatedInput: true,
      }),
    ).toMatchObject({
      providers: ["codex"],
      sessionIds: ["native-session"],
      turnIds: ["native-turn"],
      groupBy: "turn",
      includeRepeatedInput: true,
    });
  });

  it("rejects empty provider selections and oversized native-ID queries", () => {
    expect(() => decode({ ...base, providers: [] })).toThrow();
    expect(() =>
      decode({ ...base, sessionIds: Array.from({ length: 129 }, (_, index) => `s-${index}`) }),
    ).toThrow();
    expect(() => decode({ ...base, turnIds: ["t".repeat(513)] })).toThrow();
  });
});
