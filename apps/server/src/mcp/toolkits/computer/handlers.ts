import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Effect from "effect/Effect";
import {
  ComputerChromeAutomationError,
  type ComputerChromeStatus,
  ComputerOpenUrlFailedError,
} from "@t3tools/contracts";

import * as ChromeAutomation from "../../../browser/ChromeAutomation.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExternalLauncher from "../../../process/externalLauncher.ts";
import { ComputerToolkit, ComputerStandardToolkit, ComputerScreenshotToolkit } from "./tools.ts";

const withChromeAutomation = Effect.fn("ComputerToolkit.withChromeAutomation")(function* <A>(
  operation: string,
  use: (
    automation: ChromeAutomation.ChromeAutomation["Service"],
  ) => Effect.Effect<A, ChromeAutomation.ChromeAutomationError>,
) {
  yield* McpInvocationContext.requireThreadMcpCapability("computer");
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
  computer_navigate: ({ tabId, url, waitUntil, timeoutMs }) =>
    withChromeAutomation("navigate", (automation) =>
      automation.navigate(url, {
        tabId,
        ...(waitUntil === undefined ? {} : { waitUntil }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    ),
  computer_snapshot: ({ tabId, includeDom }) =>
    withChromeAutomation("snapshot", (automation) =>
      automation.snapshot(tabId, { includeDom: includeDom === true }),
    ),
  computer_screenshot: ({ tabId }) =>
    withChromeAutomation("screenshot", (automation) => automation.screenshot(tabId)),
  computer_click: ({ tabId, target }) =>
    withChromeAutomation("click", (automation) => automation.click(target, tabId)).pipe(
      Effect.as({ completed: true as const }),
    ),
  computer_fill: ({ tabId, target, value }) =>
    withChromeAutomation("fill", (automation) => automation.fill(target, value, tabId)).pipe(
      Effect.as({ completed: true as const }),
    ),
  computer_type: ({ tabId, target, value }) =>
    withChromeAutomation("type", (automation) => automation.type(target, value, tabId)).pipe(
      Effect.as({ completed: true as const }),
    ),
  computer_close: () =>
    withChromeAutomation("close", (automation) => automation.stop()).pipe(
      Effect.map(compactStatus),
    ),
  computer_open_url: Effect.fn("ComputerToolkit.computer_open_url")(function* ({ url }) {
    yield* McpInvocationContext.requireThreadMcpCapability("computer");
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

const declarations = {
  computer_start: McpToolAccess.actsAsCaller(computerHandlers.computer_start),
  computer_status: McpToolAccess.readsAsCaller(computerHandlers.computer_status),
  computer_tabs: McpToolAccess.readsAsCaller(computerHandlers.computer_tabs),
  computer_select_tab: McpToolAccess.actsAsCaller(computerHandlers.computer_select_tab),
  computer_navigate: McpToolAccess.actsAsCaller(computerHandlers.computer_navigate),
  computer_snapshot: McpToolAccess.readsAsCaller(computerHandlers.computer_snapshot),
  computer_screenshot: McpToolAccess.readsAsCaller(computerHandlers.computer_screenshot),
  computer_click: McpToolAccess.actsAsCaller(computerHandlers.computer_click),
  computer_fill: McpToolAccess.actsAsCaller(computerHandlers.computer_fill),
  computer_type: McpToolAccess.actsAsCaller(computerHandlers.computer_type),
  computer_close: McpToolAccess.actsAsCaller(computerHandlers.computer_close),
  computer_open_url: McpToolAccess.actsAsCaller(computerHandlers.computer_open_url),
};
export const ComputerToolkitHandlersLive = McpToolAccess.toLayer(ComputerToolkit, declarations);
const { computer_screenshot, ...standardHandlers } = declarations;
export const ComputerStandardToolkitHandlersLive =
  McpToolAccess.toLayer(ComputerStandardToolkit, standardHandlers);
export const ComputerScreenshotToolkitHandlersLive = McpToolAccess.toLayer(ComputerScreenshotToolkit, {
  computer_screenshot,
});
