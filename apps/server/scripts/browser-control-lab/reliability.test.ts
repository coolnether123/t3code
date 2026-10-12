// @effect-diagnostics nodeBuiltinImport:off - The lab writes Node filesystem evidence outside the production service.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { chromium, type BrowserContext, type Page } from "playwright-core";

import * as ChromeAutomation from "../../src/browser/ChromeAutomation.ts";
import * as ServerConfig from "../../src/config.ts";
import * as McpInvocationContext from "../../src/mcp/McpInvocationContext.ts";
import { computerHandlers } from "../../src/mcp/toolkits/computer/handlers.ts";
import { startFixtureServer } from "./fixture-server.ts";

class LabError extends Schema.TaggedErrorClass<LabError>()("LabError", {
  cause: Schema.Defect(),
}) {}

const promise = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new LabError({ cause }),
  });
const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
interface RunResult {
  step: string;
  run: number;
  success: boolean;
  elapsedMs: number;
  failure: string | null;
}

// Opt-in because this suite launches installed Chrome, unlike ordinary unit tests.
it.live.skipIf(HostProcessEnvironment.defaultValue().T3_BROWSER_LAB !== "1")(
  "measures local synthetic workflows through real T3 computer handlers",
  () =>
    Effect.gen(function* () {
      const env = yield* HostProcessEnvironment;
      const platform = yield* HostProcessPlatform;
      const runs = Number(env.T3_BROWSER_LAB_RUNS ?? 20);
      assert.isTrue(Number.isInteger(runs) && runs > 0 && runs <= 100);
      const evidenceDir =
        env.T3_BROWSER_LAB_EVIDENCE ??
        (yield* promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-lab-evidence-")),
        ));
      yield* promise(() => NodeFSP.mkdir(evidenceDir, { recursive: true }));
      const fixture = yield* Effect.acquireRelease(promise(startFixtureServer), (value) =>
        Effect.promise(value.close),
      );
      const executablePath = yield* ChromeAutomation.findInstalledChrome();
      assert.isDefined(executablePath, "Installed Chrome required. Do not download a browser.");
      let context: BrowserContext | undefined;
      let page: Page | undefined;
      let browserVersion = "";
      const deniedRequests: string[] = [];
      const adapter: ChromeAutomation.ChromeAutomationBrowserAdapter = {
        launchPersistentContext: async (options) => {
          context = await chromium.launchPersistentContext(options.userDataDir, {
            ...(options.executablePath === undefined
              ? {}
              : { executablePath: options.executablePath }),
            headless: true,
            args: [...options.args],
          });
          browserVersion = context.browser()?.version() ?? "unknown";
          context.on("close", options.onDisconnected);
          await context.route("**/*", (route) => {
            if (
              route
                .request()
                .url()
                .startsWith(fixture.origin + "/")
            )
              return route.continue();
            deniedRequests.push(new URL(route.request().url()).origin);
            return route.abort();
          });
          const pages = new WeakMap<Page, ChromeAutomation.ChromeAutomationPageAdapter>();
          const adapt = (target: Page) => {
            let value = pages.get(target);
            if (value === undefined) {
              value = ChromeAutomation.makePlaywrightPageAdapter(target);
              pages.set(target, value);
            }
            page = target;
            return value;
          };
          const ownedContext = context;
          return {
            pages: async () => ownedContext.pages().map(adapt),
            newPage: async () => adapt(await ownedContext.newPage()),
            close: () => ownedContext.close(),
          };
        },
      };
      const automation = yield* ChromeAutomation.make({ adapter, executablePath });
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("synthetic-browser-lab"),
        threadId: ThreadId.make("synthetic-browser-lab"),
        providerSessionId: "synthetic-browser-lab",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        capabilities: new Set(["computer"]),
        issuedAt: yield* Clock.currentTimeMillis,
      };
      const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(ChromeAutomation.ChromeAutomation, automation),
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        );
      const launchStart = NodePerfHooks.performance.now();
      const status = yield* call(computerHandlers.computer_start());
      const launchMs = NodePerfHooks.performance.now() - launchStart;
      const tabId = (yield* call(computerHandlers.computer_tabs()))[0]!.id;
      assert.isDefined(page);
      const ownedPage = page!;
      ownedPage.setDefaultTimeout(5_000);

      const snapshot = () => call(computerHandlers.computer_snapshot({ tabId }));
      const target = Effect.fn("lab.target")(function* (name: string) {
        const state = yield* snapshot();
        const matches = state.refs.filter((ref) => ref.name === name);
        assert.equal(matches.length, 1, `Expected one visible ref for ${name}`);
        return { ref: matches[0]!.ref };
      });
      const click = Effect.fn("lab.click")(function* (name: string) {
        return yield* call(computerHandlers.computer_click({ tabId, target: yield* target(name) }));
      });
      const fill = Effect.fn("lab.fill")(function* (name: string, value: string) {
        yield* call(computerHandlers.computer_fill({ tabId, target: yield* target(name), value }));
      });
      const navigate = (step: string, run: string, seed: number, mode = "") =>
        call(
          computerHandlers.computer_navigate({
            tabId,
            url: `${fixture.origin}/?${new URLSearchParams({ step, run, seed: String(seed), mode })}`,
          }),
        );
      const ready = (text: string) =>
        promise(() => ownedPage.getByRole("status").filter({ hasText: text }).waitFor());
      const results: RunResult[] = [];
      for (let run = 0; run < runs; run++) {
        for (const step of ["bank", "bill", "time"]) {
          const id = `${step}-${run}`;
          const started = NodePerfHooks.performance.now();
          const outcome = yield* Effect.gen(function* () {
            const before = fixture.receipts.length;
            yield* navigate(step, id, run);
            if (step === "bank") {
              yield* ready("Payments ready");
              yield* fill("Search saved payments", "PAY-10");
              yield* ready("Payments ready");
              yield* click("Refresh payments");
              yield* ready("Payments ready");
              yield* click("Select PAY-104");
              yield* click("Match deposit");
              const confirmState = yield* snapshot();
              assert.include(confirmState.accessibilityTree, "DEP-104 to PAY-104");
              // Check the way out before completing the same synthetic match.
              yield* click("Cancel");
              assert.equal(fixture.receipts.length, before);
              yield* click("Match deposit");
            } else if (step === "bill") {
              yield* fill("Work order", "WO-042");
              yield* fill("Department", "Operations");
              yield* fill("Reference", "REF-042");
            } else {
              yield* click("Load time cards");
              yield* ready("Cards ready");
              for (const [index, day] of days.entries())
                yield* fill(`${day} hours`, index < 5 ? "8" : "0");
            }
            const receipt = fixture.waitForSave(id);
            yield* click(
              step === "bank" ? "Confirm match" : step === "bill" ? "Save bill" : "Save timesheet",
            );
            const saved = yield* promise(() => receipt);
            yield* ready("Saved");
            const expected =
              step === "bank"
                ? { deposit: "DEP-104", payment: "PAY-104" }
                : step === "bill"
                  ? { bill: "BILL-042", fields: ["WO-042", "Operations", "REF-042"] }
                  : {
                      week: "2026-10-05",
                      entries: days.map((day, index) => ({ day, hours: index < 5 ? "8" : "0" })),
                    };
            assert.deepEqual(saved.payload, { step, seed: run, ...expected });
            assert.equal(fixture.receipts.length, before + 1, "Exactly one committed save");
            assert.include((yield* snapshot()).accessibilityTree, "Saved");
            if (run === 0)
              yield* promise(() =>
                ownedPage
                  .screenshot({ path: NodePath.join(evidenceDir, `${step}.png`) })
                  .then(() => undefined),
              );
          }).pipe(Effect.result);
          results.push({
            step,
            run,
            success: outcome._tag === "Success",
            elapsedMs: NodePerfHooks.performance.now() - started,
            failure: outcome._tag === "Failure" ? String(outcome.failure) : null,
          });
        }
      }

      const probes: { kind: string; iteration: number; observed: string }[] = [];
      for (let iteration = 0; iteration < 5; iteration++) {
        yield* navigate("bill", `refs-${iteration}`, iteration);
        const refs = yield* snapshot();
        const work = refs.refs.find((ref) => ref.name === "Work order")!;
        const department = refs.refs.find((ref) => ref.name === "Department")!;
        yield* call(
          computerHandlers.computer_fill({ tabId, target: { ref: work.ref }, value: "first" }),
        );
        const stale = yield* call(
          computerHandlers.computer_fill({
            tabId,
            target: { ref: department.ref },
            value: "second",
          }),
        ).pipe(Effect.flip);
        assert.include(stale.message, "fresh snapshot");
        probes.push({ kind: "reuse refs after an action", iteration, observed: stale.message });

        yield* navigate("bank", `detached-${iteration}`, iteration);
        yield* ready("Payments ready");
        const payment = yield* target("Select PAY-104");
        // Fixture-only stimulus detaches the element without consuming T3 refs.
        yield* promise(() => ownedPage.locator("#refresh").click());
        yield* ready("Payments ready");
        const detached = yield* call(
          computerHandlers.computer_click({ tabId, target: payment }),
        ).pipe(Effect.flip);
        assert.include(detached.message, "detached");
        probes.push({ kind: "detached dynamic-list ref", iteration, observed: detached.message });
        yield* click("Select PAY-104");

        yield* navigate("bank", `native-${iteration}`, iteration, "native");
        yield* ready("Payments ready");
        yield* click("Select PAY-104");
        const before = fixture.receipts.length;
        const clicked = yield* click("Match deposit");
        assert.equal(clicked.completed, true);
        yield* ready("Cancelled");
        assert.equal(fixture.receipts.length, before);
        probes.push({
          kind: "native JavaScript confirm",
          iteration,
          observed: "click completed, dialog auto-dismissed, zero saves",
        });
      }
      const stop = yield* call(computerHandlers.computer_close());
      assert.equal(stop.lifecycle, "stopped");
      assert.isTrue(context!.pages().length === 0, "Owned pages closed");
      const summary = ["bank", "bill", "time"].map((step) => {
        const rows = results.filter((row) => row.step === step);
        const timings = rows.map((row) => row.elapsedMs).sort((a, b) => a - b);
        return {
          step,
          runs: rows.length,
          successes: rows.filter((row) => row.success).length,
          medianMs:
            (timings[Math.floor((timings.length - 1) / 2)]! +
              timings[Math.floor(timings.length / 2)]!) /
            2,
          failureKinds: [
            ...new Set(rows.flatMap((row) => (row.failure === null ? [] : [row.failure]))),
          ],
        };
      });
      const report = {
        observedAt: DateTime.formatIso(yield* DateTime.now),
        host: NodeOS.hostname(),
        platform,
        node: process.version,
        executablePath,
        browserVersion,
        playwright: "1.60.0",
        requestedLaunchHeadless: false,
        actualLaunchHeadless: true,
        profileDir: status.profileDir,
        launchMs,
        scope:
          "T3 real computer handlers + ChromeAutomation service + real Playwright page adapter; injected headless launch only. No model, MCP transport or T3 client.",
        deniedRequests,
        summary,
        results,
        probes,
        receiptCount: fixture.receipts.length,
        receipts: fixture.receipts,
        cleanup: stop.lifecycle,
      };
      yield* promise(() =>
        NodeFSP.writeFile(
          NodePath.join(evidenceDir, "results.json"),
          JSON.stringify(report, null, 2),
        ),
      );
      yield* Effect.log({ evidenceDir, summary, probes: probes.length, cleanup: stop.lifecycle });
      assert.equal(deniedRequests.length, 0);
      assert.isTrue(
        results.every((row) => row.success),
        "See retained failures in results.json",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(NodePath.resolve("."), { prefix: "t3-browser-lab-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  { timeout: 180_000 },
);
