import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { selectNightly, compareChecks } from "./t3-nightly-sync.mjs";
NodeTest.test("nightly selection sorts numeric sequence and ignores other tags", () => {
  NodeAssert.equal(
    selectNightly([
      "v0.1.3-nightly.20261024.99",
      "v0.1.3-nightly.20261024.100",
      "v9.0.0",
      "v0.1.3-nightly.20261023.999",
    ]),
    "v0.1.3-nightly.20261024.100",
  );
});
NodeTest.test("inherited failures require exact classified baseline evidence", () => {
  const failure = {
    name: "typecheck",
    exit: 1,
    classified: true,
    failures: ["TS123 exact diagnostic"],
  };
  NodeAssert.equal(compareChecks([failure], [failure]), true);
  NodeAssert.equal(compareChecks([failure], [{ ...failure, failures: ["different"] }]), false);
  NodeAssert.equal(compareChecks([{ ...failure, classified: false }], [failure]), false);
  NodeAssert.equal(compareChecks([{ ...failure, failures: [] }], [failure]), false);
  NodeAssert.equal(compareChecks([{ ...failure, exit: 0 }], []), true);
});
