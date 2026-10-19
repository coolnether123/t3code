// @effect-diagnostics nodeBuiltinImport:off - This boundary loads an optional external Node module before provider startup.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface WorkBrowserRunBinding {
  readonly appServerArgs: ReadonlyArray<string>;
  readonly providerSpawned?: (pid: number) => Promise<unknown>;
  readonly begin: (runId: string) => Promise<unknown>;
  readonly end: (runId: string, outcome: string) => Promise<unknown>;
  readonly close: () => void;
}

export async function loadWorkBrowserRunBinding(
  environment: NodeJS.ProcessEnv = process.env,
  threadId?: string,
): Promise<WorkBrowserRunBinding | undefined> {
  const path = environment.T3_WORK_BROWSER_BINDING;
  if (!path) return undefined;
  if (!NodePath.isAbsolute(path))
    throw new Error("Work-browser binding must be an absolute module path.");
  const module: unknown = await import(NodeURL.pathToFileURL(path).href);
  if (
    !module ||
    typeof module !== "object" ||
    !("createT3RunBinding" in module) ||
    typeof module.createT3RunBinding !== "function"
  ) {
    throw new Error("Work-browser binding does not export createT3RunBinding.");
  }
  const binding: unknown = await module.createT3RunBinding({
    machine: environment.T3_WORK_BROWSER_MACHINE,
    deckTask: environment.T3_WORK_BROWSER_DECK_TASK,
    threadId,
  });
  // An external owner may leave an unadmitted thread on its existing route.
  if (binding === undefined) return undefined;
  if (
    !binding ||
    typeof binding !== "object" ||
    !("appServerArgs" in binding) ||
    !Array.isArray(binding.appServerArgs) ||
    !binding.appServerArgs.every((value: unknown) => typeof value === "string") ||
    ("providerSpawned" in binding && typeof binding.providerSpawned !== "function") ||
    !("begin" in binding) ||
    typeof binding.begin !== "function" ||
    !("end" in binding) ||
    typeof binding.end !== "function" ||
    !("close" in binding) ||
    typeof binding.close !== "function"
  ) {
    throw new Error("Work-browser binding has an invalid lifecycle contract.");
  }
  return binding as WorkBrowserRunBinding;
}
