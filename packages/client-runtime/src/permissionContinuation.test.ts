import { describe, expect, it } from "vite-plus/test";

import { parsePermissionContinuation } from "./permissionContinuation.ts";

const hookText = (where: string, quote: string, id = "J-AB12CD") =>
  `Christine already approved this ${where}, so do not ask her again: “${quote}”. ` +
  `Carry on and finish the task, including any remaining steps. (Otis permission check ${id})`;

describe("parsePermissionContinuation", () => {
  it("reads the quote, source and check id from the Stop hook's feedback", () => {
    expect(parsePermissionContinuation(hookText("in this chat", "send it to Will and me"))).toEqual(
      { quote: "send it to Will and me", source: "chat", checkId: "J-AB12CD" },
    );
  });

  it("marks approvals that rest on a standing rule", () => {
    expect(
      parsePermissionContinuation(
        hookText("in her standing workroom rules", '9. "Send it" means send.'),
      )?.source,
    ).toBe("standing-rule");
  });

  it("keeps quotes that span lines or contain quote marks", () => {
    const quote = "Prepare the note.\nThen “send” it.";
    expect(parsePermissionContinuation(hookText("in this chat", quote))?.quote).toBe(quote);
  });

  it("ignores other hook feedback and malformed text", () => {
    expect(parsePermissionContinuation("Run one more pass over the failing tests.")).toBeNull();
    expect(parsePermissionContinuation(hookText("in this chat", " "))).toBeNull();
    expect(
      parsePermissionContinuation(hookText("in this chat", "ok").replace("(Otis", "(Other")),
    ).toBeNull();
    expect(parsePermissionContinuation(undefined)).toBeNull();
  });
});
