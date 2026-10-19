import { type SubagentBackend } from "@t3tools/contracts";
import { codexAppServerCommandArgs, type CodexAppServerTransport } from "./CodexAppServerTransport.ts";
import { codexAppServerArgs } from "./codexLaunchArgs.ts";
export function codexSubagentBackendAppServerArgs(input: {
  readonly subagentBackend?: SubagentBackend;
}): ReadonlyArray<string> {
  if (input.subagentBackend === "v1") {
    return [
      "-c",
      "agents.enabled=true",
      "-c",
      "features.multi_agent=true",
      "-c",
      "features.multi_agent_v2=false",
    ];
  }
  if (input.subagentBackend === "v2") {
    return [
      "-c",
      "agents.enabled=true",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.multi_agent_v2=true",
    ];
  }
  return [];
}

export function buildCodexAppServerCommandArgs(options: {
  readonly appServerArgs?: ReadonlyArray<string>;
  readonly appServerTransport?: CodexAppServerTransport;
  readonly launchArgs?: string;
  readonly subagentBackend?: SubagentBackend;
}): ReadonlyArray<string> {
  return codexAppServerCommandArgs(options.appServerTransport ?? "stdio", [
    ...codexAppServerArgs(options.launchArgs).slice(1), ...(options.appServerArgs ?? []),
    ...codexSubagentBackendAppServerArgs(options),
  ]);
}
