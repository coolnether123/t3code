import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { runAcceptanceWithDeadline } from "./otis-call-deadline.mjs";

for (const stage of ["browser setup", "operator heard acknowledgment", "evidence cleanup"]) {
  NodeTest.test(`deadline saves a partial report during stuck ${stage}`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const output = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-call-deadline-"));
    try {
      const report = { stages: { operatorResult: 123 }, waitingFor: stage };
      const running = runAcceptanceWithDeadline({
        output,
        report,
        timeoutMs: 50,
        run: async (expired) => {
          if (stage === "evidence cleanup") {
            try {
              await expired;
            } finally {
              await new Promise(() => {});
            }
          }
          await new Promise(() => {});
        },
        close: () => new Promise(() => {}),
      });
      await Promise.resolve();
      context.mock.timers.tick(50);
      NodeAssert.equal(await running, false);
      const saved = JSON.parse(
        await NodeFSP.readFile(NodePath.join(output, "report.json"), "utf8"),
      );
      NodeAssert.equal(saved.status, "failed");
      NodeAssert.equal(saved.deadlineExpired, true);
      NodeAssert.match(saved.error, /^Acceptance deadline expired/);
      NodeAssert.equal(saved.waitingFor, stage);
      NodeAssert.equal(saved.stages.operatorResult, 123);
    } finally {
      await NodeFSP.rm(output, { recursive: true, force: true });
    }
  });
}

for (const failed of [false, true]) {
  NodeTest.test(
    `checkpoints ${failed ? "setup failure" : "successful observations"} without waiting for the deadline`,
    async () => {
      const output = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-call-deadline-"));
      const report = {};
      try {
        const accepted = await runAcceptanceWithDeadline({
          output,
          report,
          timeoutMs: 5000,
          run: async () => {
            const initial = JSON.parse(
              await NodeFSP.readFile(NodePath.join(output, "report.json"), "utf8"),
            );
            NodeAssert.equal(initial.status, "running");
            if (failed) throw new Error("Synthetic setup failure");
            report.status = "passed-observations-needs-parent-acceptance";
          },
          close: () => {},
        });
        NodeAssert.equal(accepted, !failed);
        const saved = JSON.parse(
          await NodeFSP.readFile(NodePath.join(output, "report.json"), "utf8"),
        );
        NodeAssert.equal(saved.status, report.status);
        if (failed) NodeAssert.equal(saved.status, "failed");
      } finally {
        await NodeFSP.rm(output, { recursive: true, force: true });
      }
    },
  );
}
