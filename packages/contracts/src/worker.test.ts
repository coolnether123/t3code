import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  WorkerContextPackage,
  WorkerMcpGetInput,
  WorkerMcpGetResult,
  WorkerMcpListInput,
  WorkerMcpStartInput,
  WorkerStartInput,
} from "./worker.ts";

const decodeContext = Schema.decodeUnknownSync(WorkerContextPackage);
const decodeStart = Schema.decodeUnknownSync(WorkerStartInput);
const decodeList = Schema.decodeUnknownSync(WorkerMcpListInput);
const decodeGet = Schema.decodeUnknownSync(WorkerMcpGetInput);

describe("Worker contracts", () => {
  it("keeps context explicit and defaults empty references", () => {
    expect(decodeContext({})).toEqual({ references: [], snippets: [] });
    expect(() => decodeStart({ title: "worker", assignment: "inspect" })).toThrow();
  });

  it("accepts named MCP input and result contracts", () => {
    expect(WorkerMcpStartInput).toBe(WorkerStartInput);
    expect(WorkerMcpGetResult).toBeDefined();
    expect(decodeList({})).toEqual({});
    expect(() => decodeGet({ workerId: "worker-1" })).not.toThrow();
  });
});
