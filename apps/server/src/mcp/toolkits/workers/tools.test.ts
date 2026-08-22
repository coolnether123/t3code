import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { WorkerToolkit } from "./tools.ts";

const workerToolNames = [
  "worker_start",
  "worker_list",
  "worker_wait",
  "worker_status",
  "worker_observe",
  "worker_send",
  "worker_interrupt",
  "worker_close",
  "worker_approval_respond",
] as const;

it("defines exactly the nine Worker tools", () => {
  expect(Object.keys(WorkerToolkit.tools)).toEqual(workerToolNames);
});

it("exports object inputs and useful descriptions", () => {
  for (const name of workerToolNames) {
    const tool = WorkerToolkit.tools[name];
    const schema = Tool.getJsonSchema(tool) as { readonly type?: unknown };
    expect(tool.description?.length ?? 0, `${name} needs a useful description`).toBeGreaterThan(60);
    expect(schema.type, `${name} must have an object input`).toBe("object");
  }
});

it("marks mechanical reads as read-only and lifecycle controls as destructive", () => {
  for (const name of ["worker_list", "worker_status"] as const) {
    const tool = WorkerToolkit.tools[name];
    expect(Tool.getJsonSchema(tool).type).toBe("object");
    expect(tool.annotations).toBeDefined();
  }
  for (const name of [
    "worker_start",
    "worker_send",
    "worker_interrupt",
    "worker_close",
    "worker_approval_respond",
  ] as const) {
    expect(WorkerToolkit.tools[name].annotations).toBeDefined();
  }
});
