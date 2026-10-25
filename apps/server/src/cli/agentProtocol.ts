import {
  OrchestrationV2Command,
  ProjectMutation,
  ENVIRONMENT_PROVIDER_MESSAGE_MAX_LENGTH,
  ENVIRONMENT_PROVIDER_SNAPSHOT_LIMIT,
  EnvironmentId,
  IsoDateTime,
  ProviderInstanceId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
  type EnvironmentProviderSnapshotResult,
  type OrchestrationV2ShellSnapshot as OrchestrationShellSnapshot,
  type OrchestrationV2ThreadDetailSnapshot as OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const AGENT_ACTION_MAX_BYTES = 256 * 1024;
export const AGENT_REQUEST_MAX_BYTES = 256 * 1024;
export const AGENT_OUTPUT_MAX_BYTES = 192 * 1024;
export const AGENT_RECEIPT_METADATA_MAX_BYTES = AGENT_OUTPUT_MAX_BYTES / 2;
export const AGENT_TURN_LIMIT_SCHEMA = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 5 }),
);
export const AGENT_OFFSET_SCHEMA = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 1_000_000 }),
);
const isAgentThreadId = Schema.is(ThreadId);
const isAgentTurnLimit = Schema.is(AGENT_TURN_LIMIT_SCHEMA);
const isAgentOffset = Schema.is(AGENT_OFFSET_SCHEMA);
const isAgentProviderInstanceId = Schema.is(ProviderInstanceId);
const ClientOrchestrationCommand = Schema.Union([
  ...OrchestrationV2Command.members,
  ...ProjectMutation.members,
]);

export const AGENT_COMMAND_TYPES = [
  "project.create",
  "project.update",
  "thread.create",
  "thread.metadata.update",
  "thread.pin",
  "thread.unpin",
  "thread.settle",
  "thread.unsettle",
  "thread.archive",
  "thread.unarchive",
  "message.dispatch",
  "run.interrupt",
  "runtime-request.respond",
] as const;
export type AgentCommandType = (typeof AGENT_COMMAND_TYPES)[number];

export type AgentRequest =
  | { readonly kind: "capabilities"; readonly command?: AgentCommandType }
  | {
      readonly kind: "snapshot";
      readonly threadId?: ThreadId;
      readonly turnLimit: number;
      readonly offset: number;
      readonly beforeCursor?: string;
    }
  | { readonly kind: "providers"; readonly instanceId?: ProviderInstanceId }
  | { readonly kind: "act"; readonly action: AgentAction };

export class AgentCliError extends Schema.TaggedError<AgentCliError>()("AgentCliError", {
  message: Schema.String,
}) {}

const AgentAction = Schema.Struct({
  environmentId: EnvironmentId,
  runtime: Schema.Struct({
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    startedAt: IsoDateTime,
  }),
  command: ClientOrchestrationCommand,
});
export type AgentAction = typeof AgentAction.Type;
const decodeActionJson = Schema.decodeUnknownSync(Schema.fromJsonString(AgentAction));
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export type AgentIdentity = {
  readonly environmentId: string;
  readonly runtime: { readonly pid: number; readonly startedAt: string };
};

export function agentCommandSchema(type: string) {
  if (!AGENT_COMMAND_TYPES.some((allowed) => allowed === type))
    reject("Command is not exposed by t3 agent.");
  const command = ClientOrchestrationCommand.members.find(
    (member) => "fields" in member && member.fields.type.literal === type,
  );
  if (!command) reject("Command schema is unavailable.");
  const document = Schema.toJsonSchemaDocument(command);
  return { ...document.schema, $defs: document.definitions };
}

function reject(message: string): never {
  throw new AgentCliError({ message });
}

export function decodeAgentAction(json: string): AgentAction {
  if (Buffer.byteLength(json, "utf8") > AGENT_ACTION_MAX_BYTES)
    reject("Action file exceeds 256 KiB.");
  let action: AgentAction;
  try {
    action = decodeActionJson(json, {
      onExcessProperty: "error",
    });
  } catch {
    return reject(
      "Invalid action JSON. Expected environmentId, runtime {pid, startedAt}, and an existing ClientOrchestrationCommand with no unknown fields.",
    );
  }
  const command = action.command;
  if (!AGENT_COMMAND_TYPES.some((type) => type === command.type))
    reject("Command is not exposed by t3 agent.");
  if (
    command.type === "project.update" &&
    (command.workspaceRoot !== undefined ||
      command.scripts !== undefined ||
      command.defaultModelSelection !== undefined ||
      command.defaultThreadEnvMode !== undefined ||
      command.faviconPath !== undefined ||
      command.projectIcon !== undefined ||
      command.autoPull !== undefined)
  )
    reject("Agent project metadata updates are limited to titles.");
  if (command.type === "project.create" && command.createWorkspaceRootIfMissing === true)
    reject("Agent project creation requires an existing directory.");
  if (
    command.type === "thread.create" &&
    (command.runtimeMode !== "approval-required" ||
      command.branch !== null ||
      command.worktreePath !== null)
  )
    reject(
      "New agent CLI threads require approval-required mode and the project's existing checkout.",
    );
  if (command.type === "runtime-request.respond" && command.decision === "acceptForSession")
    reject("Session-wide approval is not exposed by t3 agent. Respond to one request.");
  if (
    command.type === "thread.metadata.update" &&
    (command.branch !== undefined || command.worktreePath !== undefined)
  )
    reject("Agent thread metadata updates are limited to titles.");
  return action;
}

function requestObject(value: unknown): Record<string, unknown> {
  const object = record(value);
  if (!object) reject("Request must contain one JSON object.");
  return object;
}

function allowRequestFields(object: Record<string, unknown>, allowed: ReadonlyArray<string>): void {
  if (Object.keys(object).some((key) => !allowed.includes(key)))
    reject("Request contains an unknown field.");
}

export function assertAgentActionConfirmed(confirmed: unknown): void {
  if (confirmed !== true) reject("Act requests require confirm: true after target inspection.");
}

/** Decode the single JSON object used by a relay's fixed `t3 agent request` invocation. */
export function decodeAgentRequest(json: string): AgentRequest {
  if (Buffer.byteLength(json, "utf8") > AGENT_REQUEST_MAX_BYTES) reject("Request exceeds 256 KiB.");
  let value: unknown;
  try {
    value = decodeUnknownJson(json);
  } catch {
    return reject("Request must contain one valid JSON object.");
  }
  const object = requestObject(value);
  switch (object.kind) {
    case "capabilities": {
      allowRequestFields(object, ["kind", "command"]);
      if (object.command === undefined) return { kind: "capabilities" };
      if (
        typeof object.command !== "string" ||
        !AGENT_COMMAND_TYPES.some((type) => type === object.command)
      ) {
        return reject("Invalid capabilities command.");
      }
      return { kind: "capabilities", command: object.command as AgentCommandType };
    }
    case "snapshot": {
      allowRequestFields(object, ["kind", "thread", "turnLimit", "offset", "beforeCursor"]);
      const threadId = object.thread === undefined ? undefined : object.thread;
      if (threadId !== undefined && !isAgentThreadId(threadId))
        return reject("Invalid snapshot thread ID.");
      const turnLimit = object.turnLimit === undefined ? 3 : object.turnLimit;
      if (!isAgentTurnLimit(turnLimit))
        return reject("Snapshot turnLimit must be an integer from 1 through 5.");
      const offset = object.offset === undefined ? 0 : object.offset;
      if (!isAgentOffset(offset))
        return reject("Snapshot offset must be an integer from 0 through 1000000.");
      const beforeCursor = object.beforeCursor;
      if (beforeCursor !== undefined && typeof beforeCursor !== "string")
        return reject("Snapshot beforeCursor must be a string.");
      const request: AgentRequest = {
        kind: "snapshot",
        turnLimit,
        offset,
        ...(threadId === undefined ? {} : { threadId }),
        ...(beforeCursor === undefined ? {} : { beforeCursor }),
      };
      validateAgentRequest(request);
      return request;
    }
    case "providers": {
      allowRequestFields(object, ["kind", "instance"]);
      const instanceId = object.instance;
      if (instanceId !== undefined && !isAgentProviderInstanceId(instanceId))
        return reject("Invalid provider instance ID.");
      return {
        kind: "providers",
        ...(instanceId === undefined ? {} : { instanceId }),
      };
    }
    case "act": {
      allowRequestFields(object, ["kind", "confirm", "environmentId", "runtime", "command"]);
      assertAgentActionConfirmed(object.confirm);
      const action = decodeAgentAction(
        encodeJson({
          environmentId: object.environmentId,
          runtime: object.runtime,
          command: object.command,
        }),
      );
      return { kind: "act", action };
    }
    default:
      return reject("Unknown agent request kind.");
  }
}

export function validateAgentRequest(request: AgentRequest): void {
  if (
    request.kind === "snapshot" &&
    request.beforeCursor !== undefined &&
    request.threadId === undefined
  ) {
    reject("--before-cursor requires --thread.");
  }
}

/** Local auth storage must never authorize an arbitrary remote origin. */
export function validateAgentOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return reject("Invalid persisted server origin.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    reject(
      "Agent CLI requires a bare loopback HTTP server origin from the selected data directory.",
    );
  }
  return url.origin;
}

export function validateAgentIdentity(expected: AgentIdentity, actual: AgentIdentity): void {
  if (
    expected.environmentId !== actual.environmentId ||
    expected.runtime.pid !== actual.runtime.pid ||
    expected.runtime.startedAt !== actual.runtime.startedAt
  ) {
    reject("Environment or server runtime changed. Take a fresh snapshot before acting.");
  }
}

export function validateAgentAction(
  action: AgentAction,
  identity: AgentIdentity,
  shell: OrchestrationShellSnapshot,
  detail?: OrchestrationThreadDetailSnapshot,
  capabilities?: ExecutionEnvironmentDescriptor["capabilities"],
): void {
  validateAgentIdentity(action, identity);
  const command = action.command;
  if (
    (command.type === "thread.pin" || command.type === "thread.unpin") &&
    capabilities?.threadPinning !== true
  )
    reject("Server has not advertised thread pinning.");
  if (
    (command.type === "thread.settle" || command.type === "thread.unsettle") &&
    capabilities?.threadSettlement !== true
  )
    reject("Server has not advertised thread settlement.");
  if (command.type === "project.create") {
    if (shell.projects.some((project) => project.id === command.projectId))
      reject("Project ID already exists.");
    return;
  }
  if (command.type === "project.update") {
    if (!shell.projects.some((project) => project.id === command.projectId))
      reject("Project ID is not present in this environment.");
    return;
  }
  if (command.type === "thread.create") {
    if (!shell.projects.some((project) => project.id === command.projectId))
      reject("Project ID is not present in this environment.");
    if (shell.threads.some((thread) => thread.id === command.threadId))
      reject("Thread ID already exists.");
    return;
  }
  if (command.type === "thread.unarchive") {
    const archived = shell.archivedThreads.find((thread) => thread.id === command.threadId);
    if (archived === undefined || archived.archivedAt === null || archived.deletedAt !== null)
      reject("Archived thread must be read from this environment before restoring it.");
    return;
  }
  if (
    !("threadId" in command) ||
    detail?.projection.thread?.id !== command.threadId ||
    detail.projection.thread.deletedAt !== null
  )
    reject("Thread must be read from this environment before acting.");
  const projection = detail.projection;
  const active = projection.runs.find((run) =>
    ["running", "waiting", "starting"].includes(run.status),
  );
  if (command.type === "run.interrupt" && active?.id !== command.runId)
    reject("Observed active run no longer matches the command target.");
  if (command.type === "message.dispatch") {
    if (
      (command.dispatchMode.type === "steer_active" ||
        command.dispatchMode.type === "restart_active") &&
      active?.id !== command.dispatchMode.targetRunId
    )
      reject("Observed active run no longer matches the command target.");
    if (command.dispatchMode.type === "start_immediately" && active !== undefined)
      reject("Thread is already running. Queue or explicitly steer its active run.");
  }
  if (
    command.type === "runtime-request.respond" &&
    !projection.runtimeRequests.some(
      (request) => request.id === command.requestId && request.status === "pending",
    )
  )
    reject("Request ID has no open request evidence in the current thread snapshot.");
}

const clip = (value: string, limit = 1000) =>
  value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const textField = (value: unknown, max = 1000) =>
  typeof value === "string" ? clip(value, max) : undefined;

function compactValue(
  value: unknown,
  depth = 0,
  budget = { characters: 1500, truncated: false },
  maxDepth = 2,
): unknown {
  if (budget.characters <= 0) {
    budget.truncated = true;
    return "[content omitted]";
  }
  if (typeof value === "string") {
    const text = clip(value, Math.min(500, budget.characters));
    if (text !== value) budget.truncated = true;
    budget.characters -= text.length;
    return text;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= maxDepth) {
    if (value !== undefined) budget.truncated = true;
    return value === undefined ? undefined : "[nested content omitted]";
  }
  if (Array.isArray(value)) {
    if (value.length > 8) budget.truncated = true;
    return value.slice(0, 8).map((entry) => compactValue(entry, depth + 1, budget, maxDepth));
  }
  const object = record(value);
  if (object && Object.keys(object).length > 8) budget.truncated = true;
  return object
    ? Object.fromEntries(
        Object.entries(object)
          .slice(0, 8)
          .filter(([key]) => !["data", "image", "base64", "dataUrl"].includes(key))
          .map(([key, entry]) => [
            clip(key, 80),
            // Counts such as inputTokens are usage figures, not credentials.
            typeof entry !== "number" &&
            /authorization|credential|password|secret|token|api[_-]?key/i.test(key)
              ? "[redacted]"
              : compactValue(entry, depth + 1, budget, maxDepth),
          ]),
      )
    : undefined;
}

export function compactAgentSnapshot(
  identity: AgentIdentity,
  shell: OrchestrationShellSnapshot,
  detail?: OrchestrationThreadDetailSnapshot,
  offset = 0,
) {
  const projection = detail?.projection;
  return {
    environmentId: identity.environmentId,
    runtime: identity.runtime,
    snapshotSequence: detail?.snapshotSequence ?? shell.snapshotSequence,
    shellSequence: shell.snapshotSequence,
    projects: shell.projects.slice(offset, offset + 25).map((project) => ({
      id: project.id,
      title: clip(project.title, 300),
      workspaceRoot: project.workspaceRoot,
    })),
    threads: shell.threads.slice(offset, offset + 25).map((thread) => ({
      id: thread.id,
      title: clip(thread.title, 300),
      projectId: thread.projectId,
      activeRunId: thread.activeRunId,
      status: thread.status,
      pendingRuntimeRequest: thread.pendingRuntimeRequest,
    })),
    threadCount: shell.threads.length,
    projectsOmitted: Math.max(0, shell.projects.length - offset - 25),
    threadsOmitted: Math.max(0, shell.threads.length - offset - 25),
    listPage: {
      offset,
      limit: 25,
      nextOffset:
        Math.max(shell.projects.length, shell.threads.length) > offset + 25 ? offset + 25 : null,
    },
    ...(projection === undefined
      ? {}
      : {
          thread: projection.thread,
          runs: projection.runs.slice(-5),
          messages: projection.messages.slice(-20).map((message) => ({
            id: message.id,
            role: message.role,
            text: clip(message.text, 2000),
            streaming: message.streaming,
          })),
          requests: projection.runtimeRequests
            .filter((request) => request.status === "pending")
            .slice(-25)
            .map((request) => {
              const item = projection.turnItems.find(
                (item) =>
                  (item.type === "user_input_request" || item.type === "approval_request") &&
                  item.requestId === request.id,
              );
              const detail =
                item?.type === "user_input_request"
                  ? { questions: item.questions }
                  : item?.type === "approval_request"
                    ? { requestKind: item.requestKind, prompt: item.prompt, options: item.options }
                    : undefined;
              return {
                ...request,
                detail: compactValue(detail, 0, { characters: 4000, truncated: false }, 5),
              };
            }),
          activity: projection.turnItems.slice(-20).map((item) =>
            compactValue(
              {
                id: item.id,
                type: item.type,
                status: item.status,
                title: item.title,
                ...("text" in item ? { text: item.text } : {}),
                ...("message" in item ? { message: item.message } : {}),
                ...("activity" in item ? { activity: item.activity } : {}),
              },
              0,
              { characters: 1500, truncated: false },
              4,
            ),
          ),
          historyCursor: detail?.historyCursor ?? null,
          hasMoreHistory: detail?.hasMoreHistory ?? false,
        }),
  };
}

export function compactAgentProviders(
  identity: AgentIdentity,
  snapshot: EnvironmentProviderSnapshotResult,
) {
  const providers = snapshot.providers
    .slice(0, ENVIRONMENT_PROVIDER_SNAPSHOT_LIMIT)
    .map((provider) => ({
      ...provider,
      ...(provider.message === undefined
        ? {}
        : {
            message: clip(provider.message, ENVIRONMENT_PROVIDER_MESSAGE_MAX_LENGTH),
            messageTruncated:
              provider.messageTruncated ||
              provider.message.length > ENVIRONMENT_PROVIDER_MESSAGE_MAX_LENGTH,
          }),
    }));
  return {
    environmentId: identity.environmentId,
    runtime: identity.runtime,
    providers,
    providerCount: snapshot.providerCount,
    providersOmitted: Math.max(
      snapshot.providersOmitted,
      snapshot.providerCount - providers.length,
    ),
    providersTruncated: snapshot.providerCount > providers.length,
  };
}

/** Reserve output space for every outcome before the command can be dispatched. */
export function validateAgentReceiptMetadata(metadata: unknown): void {
  if (Buffer.byteLength(encodeJson(metadata), "utf8") > AGENT_RECEIPT_METADATA_MAX_BYTES) {
    reject(
      "Receipt identity exceeds 96 KiB of encoded JSON. Use shorter identifiers before dispatch.",
    );
  }
}

/** A large readback must not hide a receipt for an action already dispatched. */
export function encodeAgentOutput(output: unknown): string {
  const json = encodeJson(output);
  if (Buffer.byteLength(json, "utf8") <= AGENT_OUTPUT_MAX_BYTES) return json;
  const result = record(output);
  if (result?.status === "accepted" || result?.status === "unknown") {
    const receipt = encodeJson({
      ...result,
      readback: undefined,
      readbackError:
        "Readback omitted because output exceeds 192 KiB. Read the target with a smaller history window.",
    });
    if (Buffer.byteLength(receipt, "utf8") <= AGENT_OUTPUT_MAX_BYTES) return receipt;
  }
  return reject("Output exceeds 192 KiB. Select one thread and a smaller history window.");
}
