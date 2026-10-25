import { it } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import { decodeAgentRequest } from "../apps/server/src/cli/agentProtocol.ts";
import { productionAdapter } from "./t3-deploy.mjs";

function fixture({ wrongReply = false, runtimePid = 42 } = {}) {
  const commands = [];
  let reply;
  const runtime = { pid: runtimePid, startedAt: "2026-10-25T00:00:00Z" };
  const adapter = productionAdapter(
    {
      projectId: "synthetic-project",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      healthUrls: ["synthetic:3774", "synthetic:6803", "synthetic:9445"],
    },
    {
      owners: async () => [
        {
          mode: "server",
          pid: 42,
          release: "synthetic",
          startedAt: runtime.startedAt,
          paused: false,
        },
      ],
      fetch: async () => ({ status: 200 }),
      observe: async (operation) => {
        const value = await operation();
        NodeAssert.ok(value);
        return value;
      },
      cli: async (_release, wire) => {
        const request = decodeAgentRequest(JSON.stringify(wire));
        if (request.kind === "act") {
          commands.push(request.action.command);
          if (request.action.command.type === "message.dispatch")
            reply = request.action.command.text.split("exactly ")[1].split(".")[0];
          return {};
        }
        return {
          environmentId: "synthetic-environment",
          runtime,
          messages: [
            { role: "assistant", streaming: false, text: wrongReply ? "incorrect" : reply },
          ],
          runs: [],
        };
      },
    },
  );
  return { adapter, commands };
}
it("deployment proof uses the real agent protocol and archives its labelled reply", async () => {
  const { adapter, commands } = fixture();
  const result = await adapter.health("synthetic");
  NodeAssert.equal(result.ok, true);
  NodeAssert.deepEqual(
    commands.map((command) => command.type),
    ["thread.create", "message.dispatch", "thread.archive"],
  );
  NodeAssert.match(commands[0].title, /Deployment verification deploy-proof-/);
  NodeAssert.equal(result.solReply.archived, true);
  NodeAssert.equal(commands.at(-1).threadId, commands[0].threadId);
});
it("a wrong proof reply fails health and still archives the proof thread", async () => {
  const { adapter, commands } = fixture({ wrongReply: true });
  await NodeAssert.rejects(adapter.health("synthetic"));
  NodeAssert.equal(commands.at(-1).type, "thread.archive");
  NodeAssert.equal(commands.at(-1).threadId, commands[0].threadId);
});
it("an unrelated server PID fails before creating a proof thread", async () => {
  const { adapter, commands } = fixture({ runtimePid: 43 });
  await NodeAssert.rejects(adapter.health("synthetic"));
  NodeAssert.deepEqual(commands, []);
});
