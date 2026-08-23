import * as Effect from "effect/Effect";
import { ComputerOpenUrlFailedError } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExternalLauncher from "../../../process/externalLauncher.ts";
import { ComputerToolkit } from "./tools.ts";

export const computerHandlers = {
  computer_open_url: Effect.fn("ComputerToolkit.computer_open_url")(function* ({ url }) {
    yield* McpInvocationContext.requireMcpCapability("computer");
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    yield* launcher.launchBrowser(url, { application: "chrome" }).pipe(
      Effect.tapError((cause) =>
        Effect.logError("failed to open an agent-requested URL in Chrome", {
          errorTag: cause._tag,
        }),
      ),
      Effect.mapError(
        () =>
          new ComputerOpenUrlFailedError({
            message:
              "T3 could not open the URL in Chrome. Confirm that Google Chrome is installed, then retry.",
          }),
      ),
    );
    return { opened: true as const };
  }),
} satisfies Parameters<typeof ComputerToolkit.toLayer>[0];

export const ComputerToolkitHandlersLive = ComputerToolkit.toLayer(computerHandlers);
