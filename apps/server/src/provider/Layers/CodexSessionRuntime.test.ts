import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  buildCodexDeveloperInstructions,
  codexDefaultModeDeveloperInstructions,
  codexPlanModeDeveloperInstructions,
} from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildMcpApprovalResponse,
  buildPermissionsApprovalResponse,
  buildCodexAppServerCommandArgs,
  buildTurnStartParams,
  classifyCodexStderrLine,
  codexSubagentBackendAppServerArgs,
  buildCodexDaemonThreadConfig,
  assertCodexSubagentIsolationConfig,
  formatCodexThreadMcpInventory,
  formatCodexDesktopPluginSkills,
  hasConfiguredMcpServer,
  readCodexThreadMcpInventory,
  readCodexBrowserAvailability,
  isComputerUseMcpApproval,
  isMcpToolApproval,
  makeMemoryConsolidationNotificationFilter,
  mcpApprovalRequestKind,
  openCodexThread,
  initializeCodexSessionClient,
  parseCodexDaemonThreadConfig,
} from "./CodexSessionRuntime.ts";
import { isWorkerLifecycleToolName } from "../../worker/WorkerThreadBoundary.ts";
import { CODEX_SESSION_OPEN_TIMEOUT } from "../CodexRequestDeadline.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("Codex stderr classification", () => {
  it("drops exact structured MCP retry payloads captured from the live provider", () => {
    const payloads = [
      '{"timestamp":"2026-08-24T16:47:37.859069Z","level":"WARN","fields":{"message":"streamable HTTP post_message failed","endpoint_scheme":"http","endpoint_host":"localhost","endpoint_port":27985},"target":"rmcp::transport"}',
      '{"timestamp":"2026-08-24T16:47:37.859107Z","level":"ERROR","fields":{"message":"worker quit with fatal: Transport channel closed, when Client(HttpRequest(HttpRequest(\\"http/request failed\\")))"},"target":"rmcp::service"}',
      '{"timestamp":"2026-08-24T16:47:37.859158Z","level":"WARN","fields":{"message":"streamable HTTP MCP initialize failed with a retryable error; retrying","attempt":2,"max_attempts":3},"target":"rmcp::transport"}',
    ];

    for (const payload of payloads) {
      NodeAssert.equal(classifyCodexStderrLine(payload), null);
    }
  });

  it("keeps genuine structured provider errors without transport metadata", () => {
    NodeAssert.deepStrictEqual(
      classifyCodexStderrLine(
        '{"timestamp":"2026-08-24T16:47:37Z","level":"ERROR","fields":{"message":"failed to connect to websocket: HTTP 503"},"target":"codex_api::responses"}',
      ),
      { message: "failed to connect to websocket: HTTP 503" },
    );
  });
});

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

describe("buildPermissionsApprovalResponse", () => {
  const permissions = {
    network: { enabled: true },
    fileSystem: {
      entries: [{ access: "write" as const, path: { type: "path" as const, path: "/tmp" } }],
    },
  };

  it("grants the requested execution context for this turn", () => {
    NodeAssert.deepStrictEqual(buildPermissionsApprovalResponse(permissions, "accept"), {
      permissions,
      scope: "turn",
    });
  });

  it("persists an accepted execution context only for acceptForSession", () => {
    NodeAssert.deepStrictEqual(buildPermissionsApprovalResponse(permissions, "acceptForSession"), {
      permissions,
      scope: "session",
    });
  });

  it("denies every requested capability on decline or cancellation", () => {
    for (const decision of ["decline", "cancel"] as const) {
      NodeAssert.deepStrictEqual(buildPermissionsApprovalResponse(permissions, decision), {
        permissions: {},
        scope: "turn",
      });
    }
  });
});

describe("MCP tool approval", () => {
  const request = {
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      connector_id: "computer-use",
      persist: ["session", "always"],
    },
    message: "Allow Computer Use to control this desktop?",
    mode: "form" as const,
    requestedSchema: { type: "object" as const, properties: {} },
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
  };

  it("recognizes only the Computer Use connector approval", () => {
    NodeAssert.equal(isComputerUseMcpApproval(request), true);
    NodeAssert.equal(
      isComputerUseMcpApproval({
        ...request,
        _meta: { ...request._meta, connector_id: "calendar" },
      }),
      false,
    );
  });

  it("recognizes generic MCP tool guardian approvals without a connector id", () => {
    const genericRequest = {
      ...request,
      _meta: { codex_approval_kind: "mcp_tool_call" as const },
      message: "Allow node_repl to run this tool call?",
      serverName: "node_repl",
    };

    NodeAssert.equal(isMcpToolApproval(genericRequest), true);
    NodeAssert.equal(isComputerUseMcpApproval(genericRequest), false);
    NodeAssert.equal(mcpApprovalRequestKind(genericRequest), "tool");
    NodeAssert.equal(mcpApprovalRequestKind(request), "permissions");
  });

  it("does not recognize URL or unrelated form elicitations as MCP tool approvals", () => {
    NodeAssert.equal(
      isMcpToolApproval({
        ...request,
        mode: "url",
        url: "https://example.com/approve",
        elicitationId: "elicitation-1",
      }),
      false,
    );
    const unrelatedRequest = {
      ...request,
      _meta: { connector_id: "computer-use" },
    };
    NodeAssert.equal(isMcpToolApproval(unrelatedRequest), false);
    NodeAssert.equal(mcpApprovalRequestKind(unrelatedRequest), undefined);
    NodeAssert.equal(
      mcpApprovalRequestKind({
        ...request,
        mode: "url",
        url: "https://example.com/approve",
        elicitationId: "elicitation-1",
      }),
      undefined,
    );
  });

  it("maps approval decisions to MCP actions and session persistence", () => {
    NodeAssert.deepStrictEqual(buildMcpApprovalResponse("accept"), { action: "accept" });
    NodeAssert.deepStrictEqual(buildMcpApprovalResponse("acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
    });
    NodeAssert.deepStrictEqual(buildMcpApprovalResponse("decline"), { action: "decline" });
    NodeAssert.deepStrictEqual(buildMcpApprovalResponse("cancel"), { action: "cancel" });
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
  it.effect("does not advertise full control without an app-server environment", () =>
    Effect.gen(function* () {
      for (const computerControlMode of ["chrome", "desktop"] as const) {
        const params = yield* buildTurnStartParams({
          threadId: `provider-thread-no-remote-control-${computerControlMode}`,
          runtimeMode: "full-access",
          interactionMode: "default",
          computerControlMode,
          computerControlAvailable: false,
          browserToolsAvailable: true,
        });
        const instructions = params.collaborationMode?.settings.developer_instructions ?? "";

        NodeAssert.doesNotMatch(instructions, /Full Windows and Chrome control/);
        NodeAssert.doesNotMatch(instructions, /Full Chrome control/);
        NodeAssert.match(instructions, /preview_status/);
      }
    }),
  );

  it.effect("describes the host desktop app's browser tools for daemon threads", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-desktop-app",
        runtimeMode: "full-access",
        interactionMode: "default",
        computerControlMode: "chrome",
        computerControlAvailable: false,
        browserToolsAvailable: false,
        useDesktopAppDaemon: true,
      });
      const instructions = params.collaborationMode?.settings.developer_instructions ?? "";

      NodeAssert.match(instructions, /host Mac's Codex desktop installation/);
      NodeAssert.match(instructions, /T3 managed Chrome is not attached/);
      NodeAssert.doesNotMatch(instructions, /computer_open_url/);
    }),
  );

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
    NodeAssert.match(instructions, /follow the Worker tools' assignment and telemetry guidance/);
  });

  it("requires a visible start handoff before a meaningful Worker wait", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      enableT3Workers: true,
    });
    const handoff = instructions.indexOf("After every successful `worker_start`");
    const wait = instructions.indexOf("the next tool call must be one long, bounded `worker_wait`");
    NodeAssert.ok(handoff >= 0);
    NodeAssert.ok(wait > handoff);
    NodeAssert.match(
      instructions,
      /Name the Worker, state its bounded assignment, name the expected deliverable/,
    );
    NodeAssert.match(
      instructions,
      /If you say that you are waiting now, the next tool call must be one long, bounded `worker_wait`/,
    );
    NodeAssert.match(instructions, /do not poll with `worker_status` or `worker_observe`/);
    NodeAssert.match(instructions, /do not replace it with short repeated waits/);
    NodeAssert.match(instructions, /re-enter the same logical long wait session/);
    NodeAssert.match(instructions, /never create nested Workers/);
  });

  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(codexDefaultModeDeveloperInstructions(true)));
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(codexPlanModeDeveloperInstructions(true)));
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
  it("does not invent desktop control or blanket consent for the legacy desktop preference", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      computerControlMode: "desktop",
    });

    NodeAssert.match(instructions, /does not attach Codex desktop Computer Use/);
    NodeAssert.doesNotMatch(
      instructions,
      /Full Windows and Chrome control|no domain allowlist|mcp__node_repl__js/,
    );
  });

  it("distinguishes preview, managed Chrome, and the unsupported desktop preference", () => {
    const common = {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      computerControlAvailable: true,
    } as const;
    const preview = buildCodexDeveloperInstructions("default", {
      ...common,
      computerControlMode: "preview",
    });
    const chrome = buildCodexDeveloperInstructions("default", {
      ...common,
      computerControlMode: "chrome",
    });
    const desktop = buildCodexDeveloperInstructions("plan", {
      ...common,
      computerControlMode: "desktop",
    });

    NodeAssert.match(preview, /preview_status/);
    NodeAssert.match(preview, /Do not switch to global browser skills/);
    NodeAssert.match(chrome, /T3 managed Chrome/);
    NodeAssert.match(chrome, /separate persistent Chrome profile/);
    NodeAssert.match(desktop, /does not attach Codex desktop Computer Use/);
  });

  it("prefers authenticated T3 Chrome tools when they are attached", () => {
    for (const computerControlMode of ["chrome", "desktop"] as const) {
      const instructions = buildCodexDeveloperInstructions("default", {
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        computerControlMode,
        computerControlAvailable: true,
      });

      NodeAssert.match(
        instructions,
        /computer_start.*computer_status.*computer_tabs.*computer_select_tab/s,
      );
      NodeAssert.match(instructions, /computer_navigate.*computer_snapshot.*computer_click/s);
      NodeAssert.match(instructions, /computer_fill.*computer_type.*computer_close/s);
      NodeAssert.match(instructions, /persistent Chrome profile/);
      NodeAssert.doesNotMatch(instructions, /node_repl|Chrome-extension diagnostics/);
    }
  });

  it("reports unavailable desktop control without a private fallback", () => {
    const instructions = buildCodexDeveloperInstructions(
      "default",
      {
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        computerControlMode: "desktop",
      },
      false,
    );

    NodeAssert.match(instructions, /does not attach Codex desktop Computer Use/);
    NodeAssert.doesNotMatch(instructions, /computer_start|mcp__node_repl__js|@oai\/sky/);
  });

  it("keeps the base collaboration modes independent from browser availability", () => {
    for (const instructions of [
      codexDefaultModeDeveloperInstructions(true),
      codexPlanModeDeveloperInstructions(true),
      codexDefaultModeDeveloperInstructions(false),
      codexPlanModeDeveloperInstructions(false),
    ]) {
      NodeAssert.doesNotMatch(instructions, /preview_status/);
      NodeAssert.doesNotMatch(instructions, /preview_open/);
      NodeAssert.doesNotMatch(instructions, /T3 Code collaborative browser/);
      // Steering away from other browser automation must go with the tools;
      // keeping it would leave the model talked out of its only option.
      NodeAssert.doesNotMatch(instructions, /Do not switch to global browser skills/);
      // The rest of the collaboration mode is untouched.
      NodeAssert.match(instructions, /<collaboration_mode>/);
      NodeAssert.match(instructions, /<\/collaboration_mode>/);
    }
  });

  it("only describes preview tools when preview mode has an attached MCP server", () => {
    const runtime = {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      computerControlMode: "preview" as const,
    };
    NodeAssert.match(buildCodexDeveloperInstructions("default", runtime, true), /preview_open/);
    NodeAssert.doesNotMatch(
      buildCodexDeveloperInstructions("default", runtime, false),
      /preview_open/,
    );
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

describe("readCodexBrowserAvailability", () => {
  it.effect("reads the complete thread-scoped inventory before claiming browser tools", () =>
    Effect.gen(function* () {
      const calls: Array<EffectCodexSchema.V2ListMcpServerStatusParams> = [];
      const client = {
        request: (
          _method: "mcpServerStatus/list",
          params: EffectCodexSchema.V2ListMcpServerStatusParams,
        ) => {
          calls.push(params);
          return Effect.succeed({ data: [], nextCursor: calls.length === 1 ? "page-2" : null });
        },
      };
      NodeAssert.deepStrictEqual(yield* readCodexBrowserAvailability(client, "thread-browser"), {
        managedChrome: false,
        previewBrowser: false,
      });
      NodeAssert.deepStrictEqual(calls, [
        { threadId: "thread-browser", detail: "toolsAndAuthOnly" },
        { threadId: "thread-browser", detail: "toolsAndAuthOnly", cursor: "page-2" },
      ]);
    }),
  );
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

describe("Codex desktop daemon command", () => {
  it("starts the proxy instead of a stdio app-server process", () => {
    NodeAssert.deepStrictEqual(
      buildCodexAppServerCommandArgs({
        appServerTransport: "desktop-daemon",
        launchArgs: "--strict-config",
        appServerArgs: ["-c", "model=gpt-test"],
        enableT3Workers: true,
      }),
      ["app-server", "proxy"],
    );
  });
});

describe("Codex desktop plugin skill inventory", () => {
  it("reports only skills the daemon loaded from accepted bundled roots", () => {
    const response = {
      data: [
        {
          cwd: "A:/project",
          skills: [
            {
              name: "control-chrome",
              enabled: true,
              path: "A:\\bundle\\plugins\\chrome\\skills\\control-chrome\\SKILL.md",
            },
            {
              name: "control-in-app-browser",
              enabled: true,
              path: "A:/bundle/plugins/browser/skills/control-in-app-browser/SKILL.md",
            },
            {
              name: "computer-use",
              enabled: true,
              path: "A:/bundle/plugins/computer-use/skills/computer-use/SKILL.md",
            },
            {
              name: "disabled",
              enabled: false,
              path: "A:/bundle/plugins/chrome/skills/disabled/SKILL.md",
            },
            { name: "unrelated", enabled: true, path: "A:/user/skills/unrelated/SKILL.md" },
          ],
        },
      ],
    } as unknown as EffectCodexSchema.V2SkillsListResponse;
    NodeAssert.equal(
      formatCodexDesktopPluginSkills(response, [
        "A:/bundle/plugins/chrome/skills",
        "A:/bundle/plugins/browser/skills",
        "A:/bundle/plugins/computer-use/skills",
      ]),
      "Bundled desktop plugin skills: chrome:control-chrome, browser:control-in-app-browser, computer-use:computer-use.",
    );
    NodeAssert.equal(
      formatCodexDesktopPluginSkills(response, ["A:/bundle/plugins/missing/skills"]),
      "Bundled desktop plugin skills: none reported by the daemon.",
    );
  });
});

describe("openCodexThread", () => {
  it.effect("resumes the same thread without transferring its saved history", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const client = {
        request: <M extends "thread/start" | "thread/resume" | "thread/fork">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(
            makeThreadOpenResponse(
              "provider-existing",
            ) as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };
      const response = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-existing"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: "provider-existing",
      });
      NodeAssert.equal(response.thread.id, "provider-existing");
      NodeAssert.equal(calls.length, 1);
      NodeAssert.equal(calls[0]!.method, "thread/resume");
      NodeAssert.partialDeepStrictEqual(calls[0]!.payload, {
        threadId: "provider-existing",
        excludeTurns: true,
      });
    }),
  );

  for (const mode of ["start", "resume", "fork", "history"] as const) {
    it.effect(`times out a silent thread/${mode} without replacing the chat`, () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const request = (method: string) =>
          Effect.suspend(() => {
            calls.push(method);
            return Effect.never;
          });
        const pending = yield* openCodexThread({
          client: { request, raw: { request } } as unknown as Parameters<
            typeof openCodexThread
          >[0]["client"],
          threadId: ThreadId.make("thread-silent"),
          runtimeMode: "full-access",
          cwd: "A:/fake-project",
          requestedModel: undefined,
          serviceTier: undefined,
          resumeThreadId: mode === "resume" || mode === "fork" ? "provider-existing" : undefined,
          ...(mode === "fork" ? { forkLastTurnId: "last-turn" } : {}),
          ...(mode === "history"
            ? { seedHistory: [{ role: "user" as const, text: "history" }] }
            : {}),
        }).pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust(CODEX_SESSION_OPEN_TIMEOUT);
        const error = yield* Fiber.join(pending);
        NodeAssert.match(error.message, /Codex didn't answer while opening this chat; try again/);
        NodeAssert.deepStrictEqual(calls, [
          mode === "start" ? "thread/start" : mode === "fork" ? "thread/fork" : "thread/resume",
        ]);
      }),
    );
  }

  it.effect("times out silent initialization", () =>
    Effect.gen(function* () {
      const pending = yield* initializeCodexSessionClient(
        {
          request: () => Effect.never,
          notify: () => Effect.void,
          raw: { request: () => Effect.never },
        } as unknown as Parameters<typeof initializeCodexSessionClient>[0],
        false,
        {},
      ).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(CODEX_SESSION_OPEN_TIMEOUT);
      NodeAssert.match((yield* Fiber.join(pending)).message, /No response to initialize/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails opening when desktop skill-root attachment never replies", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pending = yield* initializeCodexSessionClient(
        {
          request: () => Effect.succeed({}),
          notify: () => Effect.void,
          raw: { request: () => Effect.never },
        } as unknown as Parameters<typeof initializeCodexSessionClient>[0],
        true,
        { CODEX_HOME: "A:/fake-home" },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: () =>
            Effect.succeed(
              `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = '${NodePath.resolve("/fake-bundle").replaceAll("\\", "/")}'\n[plugins."chrome@openai-bundled"]\nenabled = true`,
            ),
          stat: () =>
            Effect.succeed({ type: "Directory" }) as unknown as ReturnType<typeof fs.stat>,
        }),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(CODEX_SESSION_OPEN_TIMEOUT);
      NodeAssert.match(
        (yield* Fiber.join(pending)).message,
        /No response to skills\/extraRoots\/set/,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attaches desktop plugin roots before thread/start and skips them for stdio", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const desktopDaemon of [true, false]) {
        const calls: string[] = [];
        const client = {
          request: (method: string) => {
            calls.push(method);
            return Effect.succeed(
              method === "thread/start" ? makeThreadOpenResponse("opened-thread") : {},
            );
          },
          notify: (method: string) => {
            calls.push(method);
            return Effect.void;
          },
          raw: {
            request: (method: string, params: { extraRoots: ReadonlyArray<string> }) => {
              NodeAssert.deepStrictEqual(params.extraRoots, [
                path.join(NodePath.resolve("/bundle"), "plugins", "chrome", "skills"),
              ]);
              calls.push(method);
              return Effect.succeed({});
            },
          },
        };
        yield* Effect.gen(function* () {
          yield* initializeCodexSessionClient(
            client as unknown as Parameters<typeof initializeCodexSessionClient>[0],
            desktopDaemon,
            { CODEX_HOME: "A:/fake-codex-home" },
          );
          yield* openCodexThread({
            client: client as unknown as Parameters<typeof openCodexThread>[0]["client"],
            threadId: ThreadId.make("thread-start"),
            runtimeMode: "full-access",
            cwd: "A:/project",
            requestedModel: undefined,
            serviceTier: undefined,
            resumeThreadId: undefined,
          });
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: () =>
              Effect.succeed(
                `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = '${NodePath.resolve("/bundle").replaceAll("\\", "/")}'\n[plugins."chrome@openai-bundled"]\nenabled = true`,
              ),
            stat: () =>
              Effect.succeed({ type: "Directory" }) as unknown as ReturnType<typeof fs.stat>,
          }),
        );
        NodeAssert.deepStrictEqual(
          calls,
          desktopDaemon
            ? ["initialize", "initialized", "skills/extraRoots/set", "thread/start"]
            : ["initialize", "initialized", "thread/start"],
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("propagates daemon thread config through start, resume, and fork", () =>
    Effect.gen(function* () {
      const calls: Array<{
        method: "thread/start" | "thread/resume" | "thread/fork";
        payload: unknown;
      }> = [];
      const config = {
        "agents.enabled": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
        "mcp_servers.t3-code.enabled": true,
        "mcp_servers.t3-code.url": "http://127.0.0.1:3774/mcp",
        "mcp_servers.t3-code.http_headers": {
          Authorization: "Bearer fake-session-token",
        },
      } as const;
      const client = {
        request: <M extends "thread/start" | "thread/resume" | "thread/fork">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(
            makeThreadOpenResponse("opened-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-start"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: undefined,
        config,
      });
      yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-resume"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "resume-thread",
        config,
      });
      yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-fork"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "resume-thread",
        forkLastTurnId: "turn-1",
        config,
      });

      NodeAssert.deepStrictEqual(
        calls.map(({ method, payload }) => ({
          method,
          config: (payload as { config?: unknown }).config,
        })),
        [
          { method: "thread/start", config },
          { method: "thread/resume", config },
          { method: "thread/fork", config },
        ],
      );
    }),
  );

  it.effect(
    "keeps Worker isolation config while rejecting daemon-native catalogs and T3 env tokens",
    () =>
      Effect.gen(function* () {
        const workerConfig = yield* parseCodexDaemonThreadConfig([
          "-c",
          "agents.enabled=false",
          "-c",
          "features.multi_agent=false",
          "-c",
          "features.multi_agent_v2=false",
          "-c",
          "mcp_servers.t3-code.url=http://127.0.0.1:3774/mcp",
        ]);
        NodeAssert.deepStrictEqual(workerConfig, {
          "agents.enabled": false,
          "features.multi_agent": false,
          "features.multi_agent_v2": false,
          "mcp_servers.t3-code.url": "http://127.0.0.1:3774/mcp",
        });

        const nativeError = yield* parseCodexDaemonThreadConfig([
          "-c",
          "features.multi_agent=true",
        ]).pipe(Effect.flip);
        NodeAssert.ok(isCodexAppServerRequestError(nativeError));
        NodeAssert.match(nativeError.errorMessage, /cannot enable the native multi-agent catalog/);

        const t3Error = yield* parseCodexDaemonThreadConfig([
          "-c",
          'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
        ]).pipe(Effect.flip);
        NodeAssert.ok(isCodexAppServerRequestError(t3Error));
        NodeAssert.match(t3Error.errorMessage, /T3 MCP bearer_token_env_var/);
      }),
  );

  it.effect("adds a per-session T3 MCP credential to daemon thread config", () =>
    Effect.gen(function* () {
      const config = yield* buildCodexDaemonThreadConfig([], {
        endpoint: "http://127.0.0.1:3774/mcp",
        authorizationHeader: "Bearer fake-session-token",
      });
      NodeAssert.deepStrictEqual(config, {
        "mcp_servers.t3-code.enabled": true,
        "mcp_servers.t3-code.url": "http://127.0.0.1:3774/mcp",
        "mcp_servers.t3-code.http_headers": {
          Authorization: "Bearer fake-session-token",
        },
      });

      const missingCredential = yield* buildCodexDaemonThreadConfig([], undefined).pipe(
        Effect.flip,
      );
      NodeAssert.match(missingCredential.message, /no usable authorization credential/);
    }),
  );

  it.effect("bounds the daemon MCP inventory while following pagination", () =>
    Effect.gen(function* () {
      const makeServer = (name: string) => ({
        name,
        authStatus: "bearerToken" as const,
        tools: {
          "private-tool-name": {
            name: "private-tool-name",
            inputSchema: { type: "object", properties: {} },
          },
        },
        resources: [],
        resourceTemplates: [],
      });
      const firstPage = Array.from({ length: 25 }, (_, index) => makeServer(`server-${index}`));
      const secondPage = Array.from({ length: 25 }, (_, index) => makeServer(`second-${index}`));
      const thirdPage = [makeServer("cua_repl"), makeServer("node_repl")];
      const pages: ReadonlyArray<EffectCodexSchema.V2ListMcpServerStatusResponse> = [
        { data: firstPage, nextCursor: "page-2" },
        { data: secondPage, nextCursor: "page-3" },
        { data: thirdPage },
      ];
      const calls: Array<EffectCodexSchema.V2ListMcpServerStatusParams> = [];
      const client = {
        request: (
          _method: "mcpServerStatus/list",
          params: EffectCodexSchema.V2ListMcpServerStatusParams,
        ) => {
          calls.push(params);
          return Effect.succeed(pages[calls.length - 1]!);
        },
      };

      const inventory = yield* readCodexThreadMcpInventory(
        client,
        "provider-thread",
        new Map([["server-0", "ready"]]),
      );
      const summary = formatCodexThreadMcpInventory(inventory);

      NodeAssert.equal(calls.length, 3);
      NodeAssert.equal(calls[0]?.cursor, undefined);
      NodeAssert.equal(calls[1]?.cursor, "page-2");
      NodeAssert.equal(calls[2]?.cursor, "page-3");
      NodeAssert.equal(inventory.servers.length, 40);
      NodeAssert.equal(inventory.omittedServers, true);
      NodeAssert.equal(inventory.hasCuaRepl, true);
      NodeAssert.equal(inventory.hasNodeRepl, true);
      NodeAssert.equal(inventory.servers[0]?.startupStatus, "ready");
      NodeAssert.match(summary, /^Tools attached to this thread:/);
      NodeAssert.match(summary, /cua_repl present; node_repl present/);
      NodeAssert.doesNotMatch(summary, /private-tool-name|connector account/i);
    }),
  );

  it("describes stdio discovery without presenting unavailable OAuth as an error", () => {
    const summary = formatCodexThreadMcpInventory({
      servers: [
        { name: "bookkeeping", startupStatus: "unknown", authStatus: "unsupported", toolCount: 28 },
      ],
      hasCuaRepl: false,
      hasNodeRepl: false,
      omittedServers: false,
    });
    NodeAssert.match(summary, /startup not observed, OAuth not used, 28 tools discovered/);
    NodeAssert.doesNotMatch(summary, /startup unknown|auth unsupported|startup ready/);
    const failed = formatCodexThreadMcpInventory({
      servers: [
        { name: "bookkeeping", startupStatus: "failed", authStatus: "unsupported", toolCount: 28 },
      ],
      hasCuaRepl: false,
      hasNodeRepl: false,
      omittedServers: false,
    });
    NodeAssert.match(failed, /startup failed/);
  });

  it.effect("preserves a missing thread's identity instead of starting a replacement", () =>
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
      NodeAssert.equal(error.errorMessage, "thread not found");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume"],
      );
      NodeAssert.equal((calls[0]!.payload as { threadId: string }).threadId, "stale-thread");
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
