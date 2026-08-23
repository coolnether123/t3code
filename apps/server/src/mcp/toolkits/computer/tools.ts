import {
  ComputerControlUnavailableError,
  ComputerOpenUrlInput,
  ComputerOpenUrlFailedError,
  ComputerOpenUrlResult,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExternalLauncher from "../../../process/externalLauncher.ts";

export const ComputerOpenUrlTool = Tool.make("computer_open_url", {
  description:
    "Open an exact absolute HTTP or HTTPS URL in the user's Google Chrome session. Use this when the Chrome extension is unavailable or Windows Computer Use cannot reliably focus the address bar. This tool has no domain allowlist and supports long authentication or relay URLs. It only navigates; continue with Chrome or Windows Computer Use to inspect and interact with the page.",
  parameters: ComputerOpenUrlInput,
  success: ComputerOpenUrlResult,
  failure: Schema.Union([ComputerControlUnavailableError, ComputerOpenUrlFailedError]),
  dependencies: [McpInvocationContext.McpInvocationContext, ExternalLauncher.ExternalLauncher],
})
  .annotate(Tool.Title, "Open URL in Google Chrome")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const ComputerToolkit = Toolkit.make(ComputerOpenUrlTool);
