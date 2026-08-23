import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildCodexAppServerCommandArgs,
  buildTurnStartParams,
  codexSubagentBackendAppServerArgs,
  assertCodexSubagentIsolationConfig,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  makeMemoryConsolidationNotificationFilter,
  openCodexThread,
} from "./CodexSessionRuntime.ts";
import { isWorkerLifecycleToolName } from "../../worker/WorkerThreadBoundary.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("passes Worker mode into the turn developer instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Implement it",
        interactionMode: "default",
        enableT3Workers: true,
      }),
    );

    NodeAssert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /worker_approval_respond/,
    );
  });

  it.effect("routes Native V1 control through T3 Workers and leaves Codex V1/V2 native", () =>
    Effect.gen(function* () {
      const nativeControl = yield* buildTurnStartParams({
        threadId: "provider-thread-native-control",
        runtimeMode: "full-access",
        prompt: "Implement it",
        interactionMode: "default",
        subagentBackend: "native-v1-control",
        enableT3Workers: true,
      });
      NodeAssert.match(
        nativeControl.collaborationMode?.settings.developer_instructions ?? "",
        /worker_start/,
      );

      for (const subagentBackend of ["v1", "v2"] as const) {
        const codexNative = yield* buildTurnStartParams({
          threadId: `provider-thread-${subagentBackend}`,
          runtimeMode: "full-access",
          prompt: "Implement it",
          interactionMode: "default",
          subagentBackend,
          enableT3Workers: true,
        });
        NodeAssert.doesNotMatch(
          codexNative.collaborationMode?.settings.developer_instructions ?? "",
          /worker_start/,
        );
      }
    }),
  );

  it.effect("reports the same fallback model and effort in settings and instructions", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      });

      const settings = params.collaborationMode?.settings;
      NodeAssert.equal(settings?.model, DEFAULT_MODEL);
      NodeAssert.equal(settings?.reasoning_effort, "medium");
      NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
    }),
  );

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it.effect("omits collaboration mode when interaction mode is absent", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "readOnly",
        },
        input: [
          {
            type: "text",
            text: "Review",
          },
        ],
      });
    }),
  );
});

describe("buildCodexDeveloperInstructions", () => {
  it("leaves disabled Worker-mode instructions unchanged", () => {
    const current = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });
    const disabled = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      enableT3Workers: false,
    });

    NodeAssert.equal(disabled, current);
    NodeAssert.doesNotMatch(disabled, /worker_start/);
  });

  it("directs Worker-mode parents to all nine T3 tools instead of native collaboration", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      enableT3Workers: true,
    });

    for (const tool of [
      "worker_start",
      "worker_list",
      "worker_wait",
      "worker_status",
      "worker_observe",
      "worker_send",
      "worker_interrupt",
      "worker_close",
      "worker_approval_respond",
    ]) {
      NodeAssert.match(instructions, new RegExp(`\\b${tool}\\b`));
    }
    for (const nativeTool of [
      "spawn_agent",
      "send_message",
      "followup_task",
      "interrupt_agent",
      "list_agents",
      "wait_agent",
      "multi_agent_v1",
    ]) {
      NodeAssert.match(instructions, new RegExp(`Do not call[^.]*${nativeTool}`));
    }
  });

  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

describe("Codex sub-agent tool catalog routing", () => {
  it.effect("fails closed unless app-server reports every isolation gate as disabled", () =>
    Effect.gen(function* () {
      yield* assertCodexSubagentIsolationConfig({
        agents: { enabled: false },
        features: { multi_agent: false, multi_agent_v2: false },
      } as unknown as EffectCodexSchema.V2ConfigReadResponse["config"]);

      for (const config of [
        { features: { multi_agent: false, multi_agent_v2: false } },
        { agents: { enabled: true }, features: { multi_agent: false, multi_agent_v2: false } },
        { agents: { enabled: false }, features: { multi_agent: true, multi_agent_v2: false } },
        { agents: { enabled: false }, features: { multi_agent: false, multi_agent_v2: true } },
      ]) {
        const result = yield* assertCodexSubagentIsolationConfig(
          config as unknown as EffectCodexSchema.V2ConfigReadResponse["config"],
        ).pipe(Effect.result);
        NodeAssert.equal(result._tag, "Failure");
        NodeAssert.match(result.failure.message, /did not apply.*isolation/i);
      }
    }),
  );

  it("removes native V1/V2 tools at process launch for T3 Workers while preserving unrelated tools", () => {
    const commandArgs = buildCodexAppServerCommandArgs({
      launchArgs: "--strict-config -c features.multi_agent=true",
      appServerArgs: [
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
        "-c",
        "tools.web_search=true",
      ],
      subagentBackend: "native-v1-control",
      enableT3Workers: true,
    });

    NodeAssert.deepStrictEqual(commandArgs, [
      "app-server",
      "--strict-config",
      "-c",
      "features.multi_agent=true",
      "-c",
      "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      "-c",
      "tools.web_search=true",
      "-c",
      "agents.enabled=false",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.multi_agent_v2=false",
    ]);
    NodeAssert.equal(commandArgs.at(-3), "features.multi_agent=false");
    NodeAssert.equal(commandArgs.at(-1), "features.multi_agent_v2=false");
    NodeAssert.ok(commandArgs.includes("agents.enabled=false"));
    NodeAssert.ok(commandArgs.includes("tools.web_search=true"));
    NodeAssert.ok(commandArgs.some((argument) => argument.startsWith("mcp_servers.t3-code.")));
  });

  it("selects exactly one Codex-native multi-agent runtime for V1 or V2", () => {
    NodeAssert.deepStrictEqual(
      codexSubagentBackendAppServerArgs({ subagentBackend: "v1", enableT3Workers: true }),
      [
        "-c",
        "agents.enabled=true",
        "-c",
        "features.multi_agent=true",
        "-c",
        "features.multi_agent_v2=false",
      ],
    );
    NodeAssert.deepStrictEqual(
      codexSubagentBackendAppServerArgs({ subagentBackend: "v2", enableT3Workers: true }),
      [
        "-c",
        "agents.enabled=true",
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.multi_agent_v2=true",
      ],
    );
  });

  it("preserves ordinary provider defaults when no backend is selected and Workers are disabled", () => {
    NodeAssert.deepStrictEqual(codexSubagentBackendAppServerArgs({ enableT3Workers: false }), []);
  });

  it("hard-disables every native catalog for Worker sessions regardless of model metadata", () => {
    const commandArgs = buildCodexAppServerCommandArgs({
      launchArgs: "-c agents.enabled=true -c features.multi_agent_v2=true",
      appServerArgs: ["-c", "tools.web_search=true"],
      enableT3Workers: false,
      workerSession: true,
    });

    NodeAssert.deepStrictEqual(commandArgs.slice(-6), [
      "-c",
      "agents.enabled=false",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.multi_agent_v2=false",
    ]);
    NodeAssert.ok(commandArgs.includes("tools.web_search=true"));
  });

  it("recognizes native, legacy, collaboration, and T3 Worker lifecycle aliases", () => {
    for (const name of [
      "collaboration.spawn_agent",
      "multi_agent_v1__send_input",
      "mcp__t3_code__worker_start",
      "spawn_agent",
      "followup_task",
      "send_message",
      "interrupt_agent",
      "list_agents",
      "wait_agent",
      "resume_agent",
      "close_agent",
    ]) {
      NodeAssert.equal(isWorkerLifecycleToolName(name), true, name);
    }
    NodeAssert.equal(isWorkerLifecycleToolName("spawn_agent", "collaboration"), true);
    NodeAssert.equal(isWorkerLifecycleToolName("exec_command"), false);
    NodeAssert.equal(isWorkerLifecycleToolName("read_file"), false);
    NodeAssert.equal(isWorkerLifecycleToolName("skill_search"), false);
  });
});

function makeThreadStartedNotification(
  threadId: string,
  source: EffectCodexSchema.V2ThreadStartedNotification["thread"]["source"],
  threadSource?: string,
) {
  return {
    method: "thread/started" as const,
    params: {
      thread: {
        cliVersion: "0.0.0",
        createdAt: 0,
        cwd: "/tmp/project",
        ephemeral: true,
        id: threadId,
        modelProvider: "openai",
        preview: "",
        sessionId: threadId,
        source,
        status: { type: "idle" as const },
        ...(threadSource ? { threadSource } : {}),
        turns: [],
        updatedAt: 0,
      },
    },
  };
}

describe("makeMemoryConsolidationNotificationFilter", () => {
  it("suppresses memory consolidation without hiding other Codex subagents", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
      ),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "internal memory update",
          itemId: "memory-message",
          threadId: "memory-thread",
          turnId: "memory-turn",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "serverRequest/resolved",
        params: {
          requestId: "memory-approval",
          threadId: "memory-thread",
        },
      }),
      false,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "warning",
        params: {
          message: "internal warning",
          threadId: "memory-thread",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "normal reply",
          itemId: "root-message",
          threadId: "root-thread",
          turnId: "root-turn",
        },
      }),
      false,
    );

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("legacy-memory-thread", {
          subAgent: "memory_consolidation",
        }),
      ),
      true,
    );

    for (const source of [
      { subAgent: "review" as const },
      { subAgent: "compact" as const },
      {
        subAgent: {
          thread_spawn: {
            depth: 1,
            parent_thread_id: "root-thread",
          },
        },
      },
    ]) {
      NodeAssert.equal(
        shouldSuppress(makeThreadStartedNotification("visible-subagent", source)),
        false,
      );
    }
  });

  it("forgets memory consolidation threads after they close", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();
    shouldSuppress(
      makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
    );

    NodeAssert.equal(
      shouldSuppress({
        method: "thread/closed",
        params: { threadId: "memory-thread" },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "later message",
          itemId: "later-message",
          threadId: "memory-thread",
          turnId: "later-turn",
        },
      }),
      false,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("matches a missing rollout for a known thread id", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{
        method: "thread/start" | "thread/resume" | "thread/fork";
        payload: unknown;
      }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume" | "thread/fork">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume" | "thread/fork">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});
