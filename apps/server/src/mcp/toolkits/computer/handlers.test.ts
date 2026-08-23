import {
  ComputerControlUnavailableError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExternalLauncher from "../../../process/externalLauncher.ts";
import { computerHandlers } from "./handlers.ts";

const invocation = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  capabilities,
  issuedAt: 1,
});

const launcher = (
  launchBrowser: (
    target: string,
    options?: ExternalLauncher.LaunchBrowserOptions,
  ) => Effect.Effect<void>,
) =>
  ExternalLauncher.ExternalLauncher.of({
    resolveAvailableEditors: () => Effect.succeed([]),
    launchBrowser,
    launchEditor: () => Effect.die("unused launchEditor"),
  });

it.effect(
  "opens the exact URL through the host launcher when full computer control is active",
  () =>
    Effect.gen(function* () {
      const opened: Array<{
        readonly target: string;
        readonly options: ExternalLauncher.LaunchBrowserOptions | undefined;
      }> = [];
      const url =
        "https://example.com/sso/saml?SAMLRequest=long-auth-state&RelayState=https%3A%2F%2Fexample.com%2Fdashboard";
      const result = yield* computerHandlers.computer_open_url({ url }).pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(["computer"])),
        ),
        Effect.provideService(
          ExternalLauncher.ExternalLauncher,
          launcher((target, options) => Effect.sync(() => opened.push({ target, options }))),
        ),
      );

      expect(opened).toEqual([{ target: url, options: { application: "chrome" } }]);
      expect(result).toEqual({ opened: true });
    }),
);

it.effect("fails closed before launching when the provider turn lacks computer authority", () =>
  Effect.gen(function* () {
    let launched = false;
    const error = yield* computerHandlers.computer_open_url({ url: "https://example.com" }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(new Set())),
      Effect.provideService(
        ExternalLauncher.ExternalLauncher,
        launcher(() => Effect.sync(() => (launched = true))),
      ),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(ComputerControlUnavailableError);
    expect(launched).toBe(false);
  }),
);
