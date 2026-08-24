import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ChromeAutomationModule from "./ChromeAutomation.ts";
import {
  ChromeAutomation,
  ChromeAutomationError,
  type ChromeAutomationBrowser,
  type ChromeAutomationBrowserAdapter,
  type ChromeAutomationLaunchOptions,
  type ChromeAutomationPageAdapter,
  type ChromeAutomationPageSnapshot,
} from "./ChromeAutomation.ts";

interface FakePageFixture {
  readonly page: ChromeAutomationPageAdapter;
  readonly calls: Array<FakeCall>;
}

type FakeCall =
  | {
      readonly kind: "goto";
      readonly url: string;
      readonly options: Parameters<ChromeAutomationPageAdapter["goto"]>[1];
    }
  | {
      readonly kind: "click" | "fill" | "type";
      readonly selector: string;
      readonly value?: string;
    };

const emptySnapshot: ChromeAutomationPageSnapshot = {
  accessibilityTree: "- document",
  dom: "<body></body>",
  refs: [],
};

const makeFakePage = (input: {
  readonly url: string;
  readonly title: string;
  readonly snapshot?: ChromeAutomationPageSnapshot;
  readonly gotoError?: unknown;
  readonly gotoErrors?: ReadonlyArray<unknown | undefined>;
  readonly beforeGoto?: () => void;
}): FakePageFixture => {
  let url = input.url;
  let title = input.title;
  let gotoCount = 0;
  const calls: Array<FakeCall> = [];
  const page = {
    url: () => url,
    title: async () => title,
    goto: async (nextUrl: string, options: Parameters<ChromeAutomationPageAdapter["goto"]>[1]) => {
      calls.push({ kind: "goto", url: nextUrl, options });
      input.beforeGoto?.();
      const configuredError =
        input.gotoErrors === undefined ? input.gotoError : input.gotoErrors[gotoCount++];
      if (configuredError !== undefined) throw configuredError;
      url = nextUrl;
      title = `Title for ${nextUrl}`;
    },
    snapshot: async () => input.snapshot ?? emptySnapshot,
    click: async (selector: string) => {
      calls.push({ kind: "click", selector });
    },
    fill: async (selector: string, value: string) => {
      calls.push({ kind: "fill", selector, value });
    },
    type: async (selector: string, value: string) => {
      calls.push({ kind: "type", selector, value });
    },
  } satisfies ChromeAutomationPageAdapter;
  return { page, calls };
};

const makeFakeBrowser = (input: {
  readonly pages: ReadonlyArray<FakePageFixture>;
  readonly launchError?: unknown;
  readonly launchErrors?: ReadonlyArray<unknown | undefined>;
}) => {
  const pages = [...input.pages];
  const createdPages: Array<FakePageFixture> = [];
  let closeCount = 0;
  let launchOptions: ChromeAutomationLaunchOptions | undefined;
  const launchOptionsHistory: Array<ChromeAutomationLaunchOptions> = [];
  let launchCount = 0;
  let onDisconnected: (() => void) | undefined;
  const browser: ChromeAutomationBrowser = {
    pages: async () => pages.map(({ page }) => page),
    newPage: async () => {
      const fixture = makeFakePage({ url: "about:blank", title: "New Tab" });
      pages.push(fixture);
      createdPages.push(fixture);
      return fixture.page;
    },
    close: async () => {
      closeCount += 1;
    },
  };
  const adapter: ChromeAutomationBrowserAdapter = {
    launchPersistentContext: async (options) => {
      launchOptions = options;
      launchOptionsHistory.push(options);
      const configuredError =
        input.launchErrors === undefined ? input.launchError : input.launchErrors[launchCount];
      launchCount += 1;
      onDisconnected = options.onDisconnected;
      if (configuredError !== undefined) throw configuredError;
      return browser;
    },
  };
  return {
    adapter,
    createdPages,
    get closeCount() {
      return closeCount;
    },
    get launchOptions() {
      return launchOptions;
    },
    get launchOptionsHistory() {
      return launchOptionsHistory;
    },
    get launchCount() {
      return launchCount;
    },
    disconnect: () => onDisconnected?.(),
  };
};

const provideTestServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-chrome-automation-test-",
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

it("selects Google Chrome from the Windows ProgramFiles(x86) installation root", () => {
  const programFilesX86Chrome = "D:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
  const candidates = ChromeAutomationModule.chromePathCandidates("win32", {
    "ProgramFiles(x86)": "D:\\Program Files (x86)",
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  });

  assert.equal(candidates[0], programFilesX86Chrome);
  assert.equal(candidates.indexOf(programFilesX86Chrome), 0);
});

it.effect("manages lifecycle and keeps the persistent profile under server state", () =>
  provideTestServices(
    Effect.gen(function* () {
      const fake = makeFakeBrowser({ pages: [] });
      const automation = yield* ChromeAutomationModule.make({
        adapter: fake.adapter,
        executablePath: "fake-chrome",
      });
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;

      assert.equal((yield* automation.status()).lifecycle, "stopped");
      const started = yield* automation.start();
      assert.equal(started.lifecycle, "connected");
      assert.equal(started.selectedTabId, "tab-1");
      assert.equal(fake.createdPages.length, 1);
      assert.ok(fake.launchOptions);
      const expectedProfile = path.join(config.stateDir, "browser", "chrome-profile");
      assert.equal(fake.launchOptions.userDataDir, expectedProfile);
      assert.ok(!fake.launchOptions.args.some((arg) => arg.startsWith("--user-data-dir=")));

      const stopped = yield* automation.stop();
      assert.equal(stopped.lifecycle, "stopped");
      assert.equal((yield* automation.status()).selectedTabId, undefined);
      assert.equal(fake.closeCount, 1);
    }),
  ),
);

it.effect("lists, selects, navigates, and reports tabs", () =>
  provideTestServices(
    Effect.gen(function* () {
      const first = makeFakePage({ url: "https://one.test", title: "One" });
      const second = makeFakePage({ url: "https://two.test", title: "Two" });
      const fake = makeFakeBrowser({ pages: [first, second] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });

      yield* automation.start();
      const tabs = yield* automation.listTabs();
      assert.deepEqual(tabs, [
        { id: "tab-1", url: "https://one.test", title: "One", selected: true },
        { id: "tab-2", url: "https://two.test", title: "Two", selected: false },
      ]);

      assert.deepEqual(yield* automation.selectTab("tab-2"), {
        id: "tab-2",
        url: "https://two.test",
        title: "Two",
        selected: true,
      });
      assert.deepEqual(
        yield* automation.navigate("https://two.test/next", {
          waitUntil: "domcontentloaded",
          timeoutMs: 321,
        }),
        {
          id: "tab-2",
          url: "https://two.test/next",
          title: "Title for https://two.test/next",
          selected: true,
        },
      );
      assert.deepEqual(second.calls, [
        {
          kind: "goto",
          url: "https://two.test/next",
          options: { waitUntil: "domcontentloaded", timeoutMs: 321 },
        },
      ]);
    }),
  ),
);

it.effect("stores snapshot refs and supports click, fill, and type", () =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://form.test",
        title: "Form",
        snapshot: {
          accessibilityTree: "- form",
          dom: '<button id="submit">Submit</button>',
          refs: [
            {
              ref: "ref-submit",
              selector: "#submit",
              tag: "button",
              role: "button",
              name: "Submit",
              x: 10,
              y: 20,
              width: 80,
              height: 30,
            },
          ],
        },
      });
      const fake = makeFakeBrowser({ pages: [page] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      yield* automation.start();

      const snapshot = yield* automation.snapshot();
      assert.equal(snapshot.tabId, "tab-1");
      assert.equal(snapshot.refs[0]?.selector, "#submit");
      yield* automation.click({ ref: "ref-submit" });

      const staleRefError = yield* automation.click({ ref: "ref-submit" }).pipe(Effect.flip);
      assert.instanceOf(staleRefError, ChromeAutomationError);
      assert.equal(staleRefError.operation, "target");

      yield* automation.fill({ selector: "input[name=email]" }, "a@example.com");
      yield* automation.type({ selector: "textarea[name=note]" }, "hello");
      assert.deepEqual(page.calls, [
        { kind: "click", selector: "#submit" },
        { kind: "fill", selector: "input[name=email]", value: "a@example.com" },
        { kind: "type", selector: "textarea[name=note]", value: "hello" },
      ]);
    }),
  ),
);

it.effect("reports launch, navigation, and disconnection failures", () =>
  provideTestServices(
    Effect.gen(function* () {
      const launchFailure = makeFakeBrowser({ pages: [], launchError: new Error("launch failed") });
      const failedAutomation = yield* ChromeAutomationModule.make({
        adapter: launchFailure.adapter,
      });
      const launchError = yield* failedAutomation.start().pipe(Effect.flip);
      assert.instanceOf(launchError, ChromeAutomationError);
      assert.equal(launchError.operation, "start");
      assert.equal(launchError.detail, "T3 managed Chrome is unavailable.");
      assert.equal(launchError.unavailable, true);
      assert.equal((yield* failedAutomation.status()).lifecycle, "failed");

      const page = makeFakePage({
        url: "https://error.test",
        title: "Error",
        gotoError: new Error("navigation failed"),
      });
      const fake = makeFakeBrowser({ pages: [page] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      yield* automation.start();
      const navigationError = yield* automation
        .navigate("https://error.test/next")
        .pipe(Effect.flip);
      assert.equal(navigationError.operation, "navigate");

      fake.disconnect();
      assert.equal((yield* automation.status()).lifecycle, "failed");
      assert.deepEqual(yield* automation.listTabs(), [
        { id: "tab-2", url: "https://error.test", title: "Error", selected: true },
      ]);
      assert.equal((yield* automation.status()).lifecycle, "connected");
    }),
  ),
);

it.effect("coalesces concurrent starts into one persistent browser launch", () =>
  provideTestServices(
    Effect.gen(function* () {
      const fake = makeFakeBrowser({ pages: [] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });

      const starts = yield* Effect.all([automation.start(), automation.start()], {
        concurrency: "unbounded",
      });

      assert.equal(fake.launchCount, 1);
      assert.equal(starts[0]?.lifecycle, "connected");
      assert.equal(starts[1]?.lifecycle, "connected");
    }),
  ),
);

it.effect("recovers when the managed context disconnects during an action", () =>
  provideTestServices(
    Effect.gen(function* () {
      let fake!: ReturnType<typeof makeFakeBrowser>;
      let disconnected = false;
      const page = makeFakePage({
        url: "https://disconnect.test",
        title: "Disconnect",
        beforeGoto: () => {
          if (!disconnected) {
            disconnected = true;
            fake.disconnect();
          }
        },
      });
      fake = makeFakeBrowser({ pages: [page] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });

      const tab = yield* automation.navigate("https://disconnect.test/next");

      assert.equal(tab.url, "https://disconnect.test/next");
      assert.equal(fake.launchCount, 2);
      assert.equal((yield* automation.status()).lifecycle, "connected");
    }),
  ),
);

it.effect("retries one recoverable page transport failure exactly once", () =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://retry.test",
        title: "Retry",
        gotoErrors: [new Error("Target page, context or browser has been closed"), undefined],
      });
      const fake = makeFakeBrowser({ pages: [page] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });

      const tab = yield* automation.navigate("https://retry.test/next");

      assert.equal(tab.url, "https://retry.test/next");
      assert.equal(fake.launchCount, 2);
      assert.equal(page.calls.filter((call) => call.kind === "goto").length, 2);
    }),
  ),
);

it.effect("returns one unavailable error when recovery cannot relaunch Chrome", () =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://failed-recovery.test",
        title: "Failed recovery",
        gotoError: new Error("Target page, context or browser has been closed"),
      });
      const fake = makeFakeBrowser({
        pages: [page],
        launchErrors: [
          undefined,
          new Error("relaunch failed"),
          new Error("must not relaunch again"),
        ],
      });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });

      const error = yield* automation
        .navigate("https://failed-recovery.test/next")
        .pipe(Effect.flip);

      assert.equal(error.operation, "navigate");
      assert.equal(error.detail, "T3 managed Chrome is unavailable.");
      assert.equal(error.unavailable, true);
      assert.equal(fake.launchCount, 2);
    }),
  ),
);

it.effect("does not reopen Chrome as part of explicit close", () =>
  provideTestServices(
    Effect.gen(function* () {
      const fake = makeFakeBrowser({ pages: [] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });

      yield* automation.start();
      assert.equal((yield* automation.stop()).lifecycle, "stopped");
      assert.equal(fake.launchCount, 1);

      const tabs = yield* automation.listTabs();
      assert.equal(fake.launchCount, 2);
      assert.equal(tabs[0]?.selected, true);
    }),
  ),
);

it.effect("reuses the same persistent profile across automation instances", () =>
  provideTestServices(
    Effect.gen(function* () {
      const fake = makeFakeBrowser({ pages: [] });
      const first = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      yield* first.start();
      yield* first.stop();

      const second = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      yield* second.start();

      assert.equal(fake.launchOptionsHistory.length, 2);
      assert.equal(
        fake.launchOptionsHistory[0]?.userDataDir,
        fake.launchOptionsHistory[1]?.userDataDir,
      );
      assert.equal(
        fake.launchOptionsHistory[0]?.args.find((arg) => arg.startsWith("--user-data-dir=")),
        fake.launchOptionsHistory[1]?.args.find((arg) => arg.startsWith("--user-data-dir=")),
      );
    }),
  ),
);
