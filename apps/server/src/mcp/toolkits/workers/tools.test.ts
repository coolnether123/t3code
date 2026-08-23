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

it("keeps execution permission controls out of worker_start", () => {
  const schema = Tool.getJsonSchema(WorkerToolkit.tools.worker_start) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  const properties = schema.properties ?? {};
  expect(properties).toHaveProperty("displayName");
  expect(schema.required ?? []).not.toContain("displayName");
  for (const forbidden of [
    "runtimeMode",
    "permissionMode",
    "approvalPolicy",
    "sandboxMode",
    "parentThreadId",
  ]) {
    expect(properties).not.toHaveProperty(forbidden);
  }
  expect(WorkerToolkit.tools.worker_start.description).toContain(
    "runtime access mode inherits the parent session",
  );
});

it("makes Worker provider identity optional and explains deterministic inheritance", () => {
  const schema = Tool.getJsonSchema(WorkerToolkit.tools.worker_start) as {
    readonly properties?: Readonly<
      Record<
        string,
        {
          readonly properties?: Readonly<Record<string, unknown>>;
          readonly required?: ReadonlyArray<string>;
        }
      >
    >;
  };
  const modelSelection = schema.properties?.modelSelection;
  expect(modelSelection?.properties).toHaveProperty("instanceId");
  expect(modelSelection?.required ?? []).not.toContain("model");
  expect(modelSelection?.required ?? []).not.toContain("instanceId");
  expect(WorkerToolkit.tools.worker_start.description).toContain(
    "Omit modelSelection to inherit the parent's exact provider instance, model, and options",
  );
  expect(WorkerToolkit.tools.worker_start.description).toContain(
    "send only modelSelection.options",
  );
});
