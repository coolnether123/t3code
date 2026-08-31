import * as Effect from "effect/Effect";
import {
  ComputerChromeAutomationError,
  type ComputerChromeStatus,
  ComputerOpenUrlFailedError,
} from "@t3tools/contracts";

import * as ChromeAutomation from "../../../browser/ChromeAutomation.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExternalLauncher from "../../../process/externalLauncher.ts";
import { ComputerToolkit } from "./tools.ts";

const withChromeAutomation = Effect.fn("ComputerToolkit.withChromeAutomation")(function* <A>(
  operation: string,
  use: (
    automation: ChromeAutomation.ChromeAutomation["Service"],
  ) => Effect.Effect<A, ChromeAutomation.ChromeAutomationError>,
) {
  yield* McpInvocationContext.requireMcpCapability("computer");
  const automation = yield* ChromeAutomation.ChromeAutomation;
  return yield* use(automation).pipe(
    Effect.mapError(
      (cause) =>
        new ComputerChromeAutomationError({
          operation,
          message: cause.unavailable ? "T3 managed Chrome is unavailable." : cause.detail,
        }),
    ),
  );
});

const compactStatus = (status: ChromeAutomation.ChromeAutomationStatus): ComputerChromeStatus => ({
  lifecycle: status.lifecycle,
  profileDir: status.profileDir,
  ...(status.executablePath === undefined ? {} : { executablePath: status.executablePath }),
  ...(status.selectedTabId === undefined ? {} : { selectedTabId: status.selectedTabId }),
  ...(status.error === undefined ? {} : { error: status.error }),
});

export const computerHandlers = {
  computer_start: () =>
    withChromeAutomation("start", (automation) => automation.start()).pipe(
      Effect.map(compactStatus),
    ),
  computer_status: () =>
    withChromeAutomation("status", (automation) => Effect.map(automation.status(), compactStatus)),
  computer_tabs: () => withChromeAutomation("tabs", (automation) => automation.listTabs()),
  computer_select_tab: ({ tabId }) =>
    withChromeAutomation("selectTab", (automation) => automation.selectTab(tabId)),
  computer_navigate: ({ url, waitUntil, timeoutMs }) =>
    withChromeAutomation("navigate", (automation) =>
      automation.navigate(url, {
        ...(waitUntil === undefined ? {} : { waitUntil }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    ),
  computer_snapshot: ({ includeDom }) =>
    withChromeAutomation("snapshot", (automation) =>
      automation.snapshot({ includeDom: includeDom === true }),
    ),
  computer_click: ({ target }) =>
    withChromeAutomation("click", (automation) => automation.click(target)).pipe(
      Effect.as({ completed: true as const }),
    ),
  computer_fill: ({ target, value }) =>
    withChromeAutomation("fill", (automation) => automation.fill(target, value)).pipe(
      Effect.as({ completed: true as const }),
    ),
  computer_type: ({ target, value }) =>
    withChromeAutomation("type", (automation) => automation.type(target, value)).pipe(
      Effect.as({ completed: true as const }),
    ),
  computer_close: () =>
    withChromeAutomation("close", (automation) => automation.stop()).pipe(
      Effect.map(compactStatus),
    ),
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
