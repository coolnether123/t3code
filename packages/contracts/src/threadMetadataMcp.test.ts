import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadMetadataMcpUpdateInput } from "./threadMetadataMcp.ts";

const decodeUpdate = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateInput);

describe("ThreadMetadataMcpUpdateInput", () => {
  it("rejects malformed client request ids without normalizing valid keys", () => {
    assert.equal(decodeUpdate({ action: "move_section", sectionId: "ita" }).sectionId, "ita");
    assert.isNull(decodeUpdate({ action: "move_section", sectionId: null }).sectionId);
    assert.throws(() => decodeUpdate({ action: "move_section" }));
    assert.throws(() => decodeUpdate({ action: "rename", title: "New", sectionId: "ita" }));
    const validKey = "metadata-\ud83d\ude80-1";
    assert.equal(
      decodeUpdate({ action: "regenerate_title", clientRequestId: validKey }).clientRequestId,
      validKey,
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\ud800" }),
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\udc00" }),
    );
  });
});
