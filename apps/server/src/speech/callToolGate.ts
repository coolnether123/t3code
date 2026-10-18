import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { CallPolicy } from "@t3tools/contracts";
import { callIdentifier, type CallStore, type StoredConfirmation, sha256 } from "./callStore.ts";

// Unknown tools, shell commands and nested dispatchers require explicit approval.
// Names here are exact operations, never prefixes such as "get_*".
const reads = new Set([
  "Read",
  "Glob",
  "Grep",
  "get_task",
  "list_tasks",
  "list_capabilities",
  "describe_capability",
  "get_agent_presence",
  "get_agent_run",
  "get_agent_run_events",
  "get_local_agent_run",
  "get_local_agent_run_events",
  "list_agent_runs",
  "read_otis_state",
  "search_knowledge",
  "read_knowledge",
  "list_task_links",
  "list_task_owner_handoffs",
]);
const agents = new Set([
  "start_agent",
  "submit_agent_run",
  "steer_agent",
  "stop_agent",
  "cancel_agent_run",
  "resume_agent_run",
]);
export function confirmationLevel(tool: string, policy: CallPolicy) {
  if (policy === "off") return null;
  const name = tool.replace(/^mcp__otis__/, "");
  if (policy === "confirm-actions" && reads.has(name)) return null;
  return agents.has(name) ? ("read-back" as const) : ("explicit-yes" as const);
}
export function voiceCallFromMessage(messageId: string | undefined) {
  if (!messageId?.startsWith("voice:")) return undefined;
  const parts = messageId.split(":");
  if (parts.length !== 3) throw new Error("Invalid voice message identity.");
  return callIdentifier(parts[1]);
}

/** PreToolUse runs even when Claude's ordinary permission mode permits a tool. */
export function callToolHook(
  store: CallStore,
  threadId: string,
  currentCall: () => string | undefined,
): HookCallback {
  return async (input, _toolUseId, options) => {
    const callId = currentCall();
    if (!callId || input.hook_event_name !== "PreToolUse") return {};
    const result = (allow: boolean, reason: string) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: allow ? ("allow" as const) : ("deny" as const),
        permissionDecisionReason: reason,
      },
    });
    try {
      const record = await store.require(callId);
      if (record.threadId !== threadId || record.closed)
        return result(false, "This call has ended.");
      const level = confirmationLevel(input.tool_name, record.policy);
      if (!level) return {}; // Keep ordinary provider permissions in effect.
      const id = sha256(input.tool_use_id).slice(0, 32);
      const inputHash = sha256(JSON.stringify([input.tool_name, input.tool_input]));
      await store.serial(callId, async () => {
        const existing = await store.read<StoredConfirmation>(callId, `${id}.confirmation.json`);
        if (existing && existing.inputHash !== inputHash)
          throw new Error("Tool confirmation identity changed.");
        if (!existing) {
          const summary = `${input.tool_name.replace(/^mcp__otis__/, "")}: ${JSON.stringify(input.tool_input).slice(0, 300)}. Say yes to confirm, or no to cancel.`;
          await store.write(callId, `${id}.confirmation.json`, {
            id,
            tool: input.tool_name,
            summary,
            level,
            inputHash,
          });
          await store.changed(await store.require(callId));
        }
      });
      while (!options.signal.aborted) {
        const state = await store.require(callId);
        const pending = await store.read<StoredConfirmation>(callId, `${id}.confirmation.json`);
        if (state.closed) return result(false, "The call ended before confirmation.");
        if (pending?.decision)
          return result(pending.decision === "yes", "Confirmed for this exact tool invocation.");
        await store.wait(callId, state.version, options.signal);
      }
      return result(false, "Tool confirmation was interrupted.");
    } catch {
      return result(false, "Call confirmation unavailable. The action was not approved.");
    }
  };
}
