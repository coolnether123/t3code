import {
  type EnvironmentId,
  type ModelSelection,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
  WorkerDisabledError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "workers";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** Canonical selection used by the parent turn that owns this credential. */
  readonly parentModelSelection?: ModelSelection | undefined;
  /** Active canonical parent turn. Worker creation is bound to this lineage. */
  readonly parentTurnId?: TurnId | undefined;
  /** Always set by issued credentials. Missing legacy/test scopes fail closed. */
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly workingDirectory?: string | undefined;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export function requireMcpCapability(
  capability: "preview",
): Effect.Effect<McpInvocationScope, PreviewAutomationUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: "workers",
): Effect.Effect<McpInvocationScope, WorkerDisabledError, McpInvocationContext>;
export function requireMcpCapability(capability: McpCapability) {
  return Effect.gen(function* () {
    const invocation = yield* McpInvocationContext;
    if (invocation.capabilities.has(capability)) return invocation;
    if (capability === "workers") return yield* new WorkerDisabledError({});
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  });
}
