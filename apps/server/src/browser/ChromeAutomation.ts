import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { chromium, type Page } from "playwright-core";

import * as ServerConfig from "../config.ts";

const PROFILE_DIRECTORY = "browser/chrome-profile";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SNAPSHOT_CHARS = 100_000;
const UNAVAILABLE_MESSAGE = "T3 managed Chrome is unavailable.";
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, summary, [role], [contenteditable="true"]';

export type ChromeAutomationLifecycle =
  | "stopped"
  | "starting"
  | "connected"
  | "stopping"
  | "failed";

export interface ChromeAutomationStatus {
  readonly lifecycle: ChromeAutomationLifecycle;
  readonly profileDir: string;
  readonly executablePath: string | undefined;
  readonly selectedTabId: string | undefined;
  readonly error: string | undefined;
}

export interface ChromeAutomationTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly selected: boolean;
}

export interface ChromeAutomationRef {
  readonly ref: string;
  readonly selector: string;
  readonly tag: string;
  readonly role: string | null;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ChromeAutomationPageSnapshot {
  readonly accessibilityTree: string;
  readonly dom: string;
  readonly refs: ReadonlyArray<ChromeAutomationRef>;
}

export type ChromeAutomationTarget = { readonly ref: string } | { readonly selector: string };

export interface ChromeAutomationLaunchOptions {
  readonly executablePath: string | undefined;
  readonly channel: "chrome" | undefined;
  readonly userDataDir: string;
  readonly headless: false;
  readonly args: ReadonlyArray<string>;
  readonly onDisconnected: () => void;
}

export interface ChromeAutomationPageAdapter {
  readonly url: () => string;
  readonly title: () => Promise<string>;
  readonly goto: (
    url: string,
    options: {
      readonly waitUntil: "load" | "domcontentloaded" | "commit";
      readonly timeoutMs: number;
    },
  ) => Promise<void>;
  readonly snapshot: () => Promise<ChromeAutomationPageSnapshot>;
  readonly click: (selector: string) => Promise<void>;
  readonly fill: (selector: string, value: string) => Promise<void>;
  readonly type: (selector: string, value: string) => Promise<void>;
}

export interface ChromeAutomationBrowserAdapter {
  readonly launchPersistentContext: (
    options: ChromeAutomationLaunchOptions,
  ) => Promise<ChromeAutomationBrowser>;
}

export interface ChromeAutomationBrowser {
  readonly pages: () => Promise<ReadonlyArray<ChromeAutomationPageAdapter>>;
  readonly newPage: () => Promise<ChromeAutomationPageAdapter>;
  readonly close: () => Promise<void>;
}

export class ChromeAutomationError extends Error {
  readonly _tag = "ChromeAutomationError" as const;
  readonly operation: string;
  readonly detail: string;
  readonly unavailable: boolean;
  override readonly cause: unknown | undefined;

  constructor(operation: string, detail: string, cause?: unknown, unavailable = false) {
    super(`${operation}: ${detail}`);
    this.name = "ChromeAutomationError";
    this.operation = operation;
    this.detail = detail;
    this.unavailable = unavailable;
    this.cause = cause;
  }
}

export class ChromeAutomation extends Context.Service<
  ChromeAutomation,
  {
    readonly start: () => Effect.Effect<ChromeAutomationStatus, ChromeAutomationError>;
    readonly stop: () => Effect.Effect<ChromeAutomationStatus, ChromeAutomationError>;
    readonly status: () => Effect.Effect<ChromeAutomationStatus>;
    readonly listTabs: () => Effect.Effect<
      ReadonlyArray<ChromeAutomationTab>,
      ChromeAutomationError
    >;
    readonly selectTab: (
      tabId: string,
    ) => Effect.Effect<ChromeAutomationTab, ChromeAutomationError>;
    readonly navigate: (
      url: string,
      options?: {
        readonly waitUntil?: "load" | "domcontentloaded" | "commit";
        readonly timeoutMs?: number;
      },
    ) => Effect.Effect<ChromeAutomationTab, ChromeAutomationError>;
    readonly snapshot: () => Effect.Effect<
      ChromeAutomationPageSnapshot & { readonly tabId: string },
      ChromeAutomationError
    >;
    readonly click: (target: ChromeAutomationTarget) => Effect.Effect<void, ChromeAutomationError>;
    readonly fill: (
      target: ChromeAutomationTarget,
      value: string,
    ) => Effect.Effect<void, ChromeAutomationError>;
    readonly type: (
      target: ChromeAutomationTarget,
      value: string,
    ) => Effect.Effect<void, ChromeAutomationError>;
  }
>()("t3/browser/ChromeAutomation") {}

export interface ChromeAutomationOptions {
  /** Injected in tests or by a future alternate browser host. */
  readonly adapter?: ChromeAutomationBrowserAdapter;
  /** Overrides executable discovery, primarily for managed installations/tests. */
  readonly executablePath?: string;
}

export interface ChromeAutomationLaunchTarget {
  readonly executablePath: string | undefined;
  /** Playwright resolves this channel to an installed Google Chrome executable. */
  readonly channel: "chrome" | undefined;
}

interface ManagedTab {
  readonly id: string;
  readonly page: ChromeAutomationPageAdapter;
  refs: ReadonlyMap<string, string>;
}

interface SnapshotElement {
  readonly tagName: string;
  readonly previousElementSibling: SnapshotElement | null;
}

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

const failure = (operation: string, cause: unknown): ChromeAutomationError =>
  new ChromeAutomationError(operation, errorDetail(cause), cause);

const unavailableFailure = (operation: string, cause: unknown): ChromeAutomationError =>
  new ChromeAutomationError(operation, UNAVAILABLE_MESSAGE, cause, true);

const isRecoverableTransportFailure = (cause: ChromeAutomationError): boolean => {
  const detail = errorDetail(cause.cause ?? cause.detail).toLowerCase();
  return [
    "target page, context or browser has been closed",
    "target page, context or browser has been disconnected",
    "browser has been closed",
    "context has been closed",
    "page has been closed",
    "target closed",
    "session closed",
    "connection closed",
    "connection reset",
    "econnreset",
    "epipe",
    "protocol error",
    "transport closed",
    "browser disconnected",
  ].some((marker) => detail.includes(marker));
};

const escapeCssIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);

const truncate = (value: string): string =>
  value.length <= MAX_SNAPSHOT_CHARS
    ? value
    : `${value.slice(0, MAX_SNAPSHOT_CHARS)}\n[truncated by T3 Chrome automation]`;

const targetSelector = (
  target: ChromeAutomationTarget,
  refs: ReadonlyMap<string, string>,
): string => {
  if ("selector" in target) {
    if (target.selector.trim().length === 0) {
      throw new ChromeAutomationError("target", "A selector cannot be empty.");
    }
    return target.selector;
  }
  const selector = refs.get(target.ref);
  if (selector === undefined) {
    throw new ChromeAutomationError(
      "target",
      `Snapshot ref ${JSON.stringify(target.ref)} is not available. Take a fresh snapshot.`,
    );
  }
  return selector;
};

export const profileArguments = (): ReadonlyArray<string> => [
  "--no-first-run",
  "--no-default-browser-check",
];

const trimPathCandidate = (candidate: string): string => {
  const trimmed = candidate.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const appendUniquePathCandidate = (
  candidates: Array<string>,
  seen: Set<string>,
  platform: NodeJS.Platform,
  candidate: string | undefined,
): void => {
  if (candidate === undefined) return;
  const trimmed = trimPathCandidate(candidate);
  if (trimmed.length === 0) return;
  const key = platform === "win32" ? trimmed.toLowerCase() : trimmed;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(trimmed);
};

const joinWindowsPath = (root: string, relativePath: string): string =>
  `${trimPathCandidate(root).replace(/[\\/]+$/, "")}\\${relativePath}`;

export const chromePathCandidates = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> => {
  const candidates: Array<string> = [];
  const seen = new Set<string>();
  appendUniquePathCandidate(candidates, seen, platform, env.CHROME_PATH);
  appendUniquePathCandidate(candidates, seen, platform, env.CHROMIUM_PATH);

  if (platform === "win32") {
    const systemDrive =
      trimPathCandidate(env.SystemDrive ?? "") ||
      trimPathCandidate(env.SystemRoot ?? "").slice(0, 2) ||
      "C:";
    const roots = [
      // Windows names this variable `ProgramFiles(x86)`. Keep the old
      // spelling as a compatibility fallback for embedders that normalize
      // environment keys before constructing the server environment.
      env["ProgramFiles(x86)"],
      env.ProgramFilesX86,
      env.ProgramFiles,
      env.ProgramW6432,
      `${systemDrive}\\Program Files (x86)`,
      `${systemDrive}\\Program Files`,
      env.LOCALAPPDATA,
      env.USERPROFILE === undefined ? undefined : `${env.USERPROFILE}\\AppData\\Local`,
    ];
    const relativePaths = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Google\\Chrome Beta\\Application\\chrome.exe",
      "Google\\Chrome Dev\\Application\\chrome.exe",
      "Google\\Chrome SxS\\Application\\chrome.exe",
      "Google\\Chrome for Testing\\Application\\chrome.exe",
      "Chromium\\Application\\chrome.exe",
    ];
    for (const root of roots) {
      if (root === undefined || trimPathCandidate(root).length === 0) continue;
      for (const relativePath of relativePaths) {
        appendUniquePathCandidate(candidates, seen, platform, joinWindowsPath(root, relativePath));
      }
    }
    // A portable or administrator-managed installation may be exposed only
    // through PATH. These are checked after explicit standard locations.
    for (const command of ["chrome.exe", "chrome", "chromium.exe", "chromium"]) {
      appendUniquePathCandidate(candidates, seen, platform, command);
    }
    return candidates;
  }

  if (platform === "darwin") {
    for (const candidate of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      env.HOME === undefined
        ? undefined
        : `${env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      env.HOME === undefined
        ? undefined
        : `${env.HOME}/Applications/Chromium.app/Contents/MacOS/Chromium`,
    ]) {
      appendUniquePathCandidate(candidates, seen, platform, candidate);
    }
    return candidates;
  }

  for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    appendUniquePathCandidate(candidates, seen, platform, command);
  }
  return candidates;
};

export const resolveInstalledChrome = Effect.fn("ChromeAutomation.resolveInstalledChrome")(
  function* () {
    const platform = yield* HostProcessPlatform;
    const env = yield* HostProcessEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const candidates = chromePathCandidates(platform, env);
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate)) {
        const resolved = yield* resolveCommandPath(candidate, { env }).pipe(Effect.option);
        if (resolved._tag === "Some") {
          return {
            executablePath: resolved.value,
            channel: undefined,
          } satisfies ChromeAutomationLaunchTarget;
        }
        continue;
      }
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return {
          executablePath: candidate,
          channel: undefined,
        } satisfies ChromeAutomationLaunchTarget;
      }
    }

    yield* Effect.logInfo(
      "managed Chrome path discovery found no explicit executable; trying Playwright channel",
      { platform, candidates },
    );
    return {
      executablePath: undefined,
      channel: "chrome",
    } satisfies ChromeAutomationLaunchTarget;
  },
);

const makePlaywrightPageAdapter = (page: Page): ChromeAutomationPageAdapter => ({
  url: () => page.url(),
  title: () => page.title(),
  goto: async (url, options) => {
    await page.goto(url, { waitUntil: options.waitUntil, timeout: options.timeoutMs });
  },
  snapshot: async () => {
    const [accessibilityTree, dom, refs] = await Promise.all([
      page.locator("body").ariaSnapshot({ timeout: DEFAULT_TIMEOUT_MS }),
      page.locator("body").evaluate((element) => element.outerHTML),
      page.locator(INTERACTIVE_SELECTOR).evaluateAll((elements) =>
        elements.map((element, index) => {
          const htmlElement = element as unknown as {
            readonly tagName: string;
            readonly id: string;
            readonly innerText: string;
            readonly previousElementSibling: SnapshotElement | null;
            readonly getAttribute: (name: string) => string | null;
            readonly getBoundingClientRect: () => {
              readonly x: number;
              readonly y: number;
              readonly width: number;
              readonly height: number;
            };
          };
          const rect = htmlElement.getBoundingClientRect();
          const id = htmlElement.id;
          const testId = htmlElement.getAttribute("data-testid");
          const selector = id
            ? `#${escapeCssIdentifier(id)}`
            : testId
              ? `[data-testid="${testId.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`
              : `${htmlElement.tagName.toLowerCase()}:nth-of-type(${(() => {
                  let sameTagIndex = 1;
                  let sibling = htmlElement.previousElementSibling;
                  while (sibling !== null) {
                    if (sibling.tagName === htmlElement.tagName) sameTagIndex += 1;
                    sibling = sibling.previousElementSibling;
                  }
                  return sameTagIndex;
                })()})`;
          const role = htmlElement.getAttribute("role");
          const name =
            htmlElement.getAttribute("aria-label") ??
            htmlElement.innerText.trim().replace(/\s+/g, " ").slice(0, 200);
          return {
            ref: `ref-${index + 1}`,
            selector,
            tag: htmlElement.tagName.toLowerCase(),
            role,
            name,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        }),
      ),
    ]);
    return { accessibilityTree, dom, refs };
  },
  click: (selector) => page.locator(selector).click({ timeout: DEFAULT_TIMEOUT_MS }),
  fill: (selector, value) => page.locator(selector).fill(value, { timeout: DEFAULT_TIMEOUT_MS }),
  type: (selector, value) =>
    page.locator(selector).pressSequentially(value, { timeout: DEFAULT_TIMEOUT_MS }),
});

const makePlaywrightAdapter = (): ChromeAutomationBrowserAdapter => ({
  launchPersistentContext: async (options) => {
    const context = await chromium.launchPersistentContext(options.userDataDir, {
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      ...(options.channel === undefined ? {} : { channel: options.channel }),
      headless: options.headless,
      args: [...options.args],
    });
    context.on("close", options.onDisconnected);
    const pages = new WeakMap<Page, ChromeAutomationPageAdapter>();
    const adaptPage = (page: Page): ChromeAutomationPageAdapter => {
      const existing = pages.get(page);
      if (existing !== undefined) return existing;
      const adapted = makePlaywrightPageAdapter(page);
      pages.set(page, adapted);
      return adapted;
    };
    return {
      pages: async () => (await context.pages()).map(adaptPage),
      newPage: async () => adaptPage(await context.newPage()),
      close: () => context.close(),
    };
  },
});

export const make = Effect.fn("ChromeAutomation.make")(function* (
  options: ChromeAutomationOptions = {},
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mutex = yield* Semaphore.make(1);
  const profileDir = path.join(config.stateDir, PROFILE_DIRECTORY);
  const adapter = options.adapter ?? makePlaywrightAdapter();
  const shouldDiscoverExecutable =
    options.adapter === undefined && options.executablePath === undefined;
  let executablePath =
    options.executablePath ?? (shouldDiscoverExecutable ? undefined : "injected");
  let launchChannel: ChromeAutomationLaunchTarget["channel"] = undefined;

  let browser: ChromeAutomationBrowser | undefined;
  let selectedTabId: string | undefined;
  let tabSequence = 0;
  let tabs = new Map<string, ManagedTab>();
  let status: ChromeAutomationStatus = {
    lifecycle: "stopped",
    profileDir,
    executablePath,
    selectedTabId: undefined,
    error: undefined,
  };
  let expectedDisconnect = false;
  let connectionSequence = 0;
  let activeConnection = 0;
  let preferredTabUrl: string | undefined;

  const provideExecutableDiscoveryServices = <A, E, R>(
    effect: Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const rememberSelectedTab = () => {
    if (selectedTabId === undefined) return;
    const selected = tabs.get(selectedTabId);
    if (selected === undefined) return;
    try {
      preferredTabUrl = selected.page.url();
    } catch {
      // The page may already be gone; the next connection will choose its first tab.
    }
  };

  const setFailed = () => {
    browser = undefined;
    tabs = new Map();
    selectedTabId = undefined;
    status = {
      ...status,
      lifecycle: "failed",
      selectedTabId: undefined,
      error: UNAVAILABLE_MESSAGE,
    };
  };

  const invalidateConnection = () => {
    rememberSelectedTab();
    const currentBrowser = browser;
    browser = undefined;
    tabs = new Map();
    selectedTabId = undefined;
    activeConnection = ++connectionSequence;
    status = {
      ...status,
      lifecycle: "failed",
      selectedTabId: undefined,
      error: UNAVAILABLE_MESSAGE,
    };
    return currentBrowser;
  };

  const failStart = (cause: unknown) =>
    Effect.gen(function* () {
      yield* Effect.logError("managed Chrome failed to start", {
        profileDir,
        executablePath: status.executablePath,
        channel: launchChannel,
        detail: errorDetail(cause),
        cause,
      });
      const currentBrowser = browser;
      expectedDisconnect = true;
      if (currentBrowser !== undefined) {
        yield* Effect.tryPromise({
          try: () => currentBrowser.close(),
          catch: (closeCause) => failure("cleanup", closeCause),
        }).pipe(Effect.orElseSucceed(() => undefined));
      }
      setFailed();
    });

  const onDisconnected = (connection: number) => {
    if (
      connection === activeConnection &&
      !expectedDisconnect &&
      status.lifecycle !== "stopped" &&
      status.lifecycle !== "stopping"
    ) {
      invalidateConnection();
    }
  };

  const refreshTabs = Effect.fn("ChromeAutomation.refreshTabs")(function* () {
    if (browser === undefined) {
      return yield* Effect.fail(new ChromeAutomationError("tabs", "Chrome is not connected."));
    }
    const pages = yield* Effect.tryPromise({
      try: () => browser!.pages(),
      catch: (cause) => failure("tabs", cause),
    });
    const nextTabs = new Map<string, ManagedTab>();
    for (const page of pages) {
      const existing = Array.from(tabs.values()).find((tab) => tab.page === page);
      const tab =
        existing ??
        ({
          id: `tab-${++tabSequence}`,
          page,
          refs: new Map<string, string>(),
        } satisfies ManagedTab);
      nextTabs.set(tab.id, tab);
    }
    tabs = nextTabs;
    if (selectedTabId !== undefined && !tabs.has(selectedTabId)) selectedTabId = undefined;
    if (selectedTabId === undefined && preferredTabUrl !== undefined) {
      for (const tab of tabs.values()) {
        const currentUrl = yield* Effect.try({
          try: () => tab.page.url(),
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined));
        if (currentUrl === preferredTabUrl) {
          selectedTabId = tab.id;
          break;
        }
      }
    }
    if (selectedTabId === undefined && tabs.size > 0) selectedTabId = tabs.keys().next().value;
    status = { ...status, selectedTabId };
    return tabs;
  });

  const selectedTab = Effect.fn("ChromeAutomation.selectedTab")(function* () {
    yield* refreshTabs();
    if (selectedTabId === undefined) {
      return yield* Effect.fail(new ChromeAutomationError("tab", "Chrome has no open tabs."));
    }
    const tab = tabs.get(selectedTabId);
    if (tab === undefined) {
      return yield* Effect.fail(
        new ChromeAutomationError("tab", "The selected tab no longer exists."),
      );
    }
    return tab;
  });

  const tabInfo = Effect.fn("ChromeAutomation.tabInfo")(function* (tab: ManagedTab) {
    const [url, title] = yield* Effect.tryPromise({
      try: () => Promise.all([Promise.resolve(tab.page.url()), tab.page.title()]),
      catch: (cause) => failure("tab", cause),
    });
    return {
      id: tab.id,
      url,
      title,
      selected: tab.id === selectedTabId,
    } satisfies ChromeAutomationTab;
  });

  const startConnected = Effect.gen(function* () {
    if (status.lifecycle === "connected" && browser !== undefined) return status;
    status = { ...status, lifecycle: "starting", error: undefined };
    expectedDisconnect = false;
    launchChannel = undefined;
    const connection = ++connectionSequence;
    const launchTarget = shouldDiscoverExecutable
      ? yield* provideExecutableDiscoveryServices(resolveInstalledChrome())
      : ({
          executablePath: executablePath!,
          channel: undefined,
        } satisfies ChromeAutomationLaunchTarget);
    executablePath = launchTarget.executablePath;
    launchChannel = launchTarget.channel;
    status = { ...status, executablePath: launchTarget.executablePath };
    activeConnection = connection;
    const launched = yield* Effect.tryPromise({
      try: () =>
        adapter.launchPersistentContext({
          executablePath: launchTarget.executablePath,
          channel: launchTarget.channel,
          userDataDir: profileDir,
          headless: false,
          args: profileArguments(),
          onDisconnected: () => onDisconnected(connection),
        }),
      catch: (cause) => failure("start", cause),
    });
    if (activeConnection !== connection || status.lifecycle === "failed") {
      expectedDisconnect = true;
      yield* Effect.tryPromise({
        try: () => launched.close(),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
      return yield* Effect.fail(new ChromeAutomationError("start", "Chrome disconnected."));
    }
    browser = launched;
    tabs = new Map();
    selectedTabId = undefined;
    yield* refreshTabs();
    if (tabs.size === 0) {
      const page = yield* Effect.tryPromise({
        try: () => browser!.newPage(),
        catch: (cause) => failure("start", cause),
      });
      const id = `tab-${++tabSequence}`;
      tabs.set(id, { id, page, refs: new Map() });
      selectedTabId = id;
    }
    status = { ...status, lifecycle: "connected", selectedTabId, error: undefined };
    preferredTabUrl = undefined;
    return status;
  });

  const startOnce = startConnected.pipe(
    Effect.tapError(failStart),
    Effect.mapError((cause) => unavailableFailure("start", cause)),
  );

  const start = mutex.withPermit(startOnce);

  const ensureConnected = Effect.fn("ChromeAutomation.ensureConnected")(function* () {
    if (status.lifecycle === "connected" && browser !== undefined) return;
    yield* startOnce;
  });

  const recoverOnce = Effect.fn("ChromeAutomation.recoverOnce")(function* (operation: string) {
    const currentBrowser = invalidateConnection();
    expectedDisconnect = true;
    if (currentBrowser !== undefined) {
      yield* Effect.tryPromise({
        try: () => currentBrowser.close(),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
    }
    yield* startOnce.pipe(
      Effect.mapError(() =>
        unavailableFailure(operation, "Recovery failed for " + operation + "."),
      ),
    );
  });

  const action = <A>(
    operation: string,
    use: () => Effect.Effect<A, ChromeAutomationError>,
  ): Effect.Effect<A, ChromeAutomationError> =>
    mutex.withPermit(
      Effect.gen(function* () {
        yield* ensureConnected();
        const first = yield* Effect.result(use());
        if (first._tag === "Success" && status.lifecycle !== "failed") return first.success;
        if (
          first._tag === "Failure" &&
          !isRecoverableTransportFailure(first.failure) &&
          status.lifecycle !== "failed"
        ) {
          return yield* Effect.fail(first.failure);
        }

        yield* recoverOnce(operation);
        const second = yield* Effect.result(use());
        if (second._tag === "Success" && status.lifecycle !== "failed") return second.success;
        if (second._tag === "Success") {
          return yield* Effect.fail(unavailableFailure(operation, "Chrome disconnected."));
        }
        if (isRecoverableTransportFailure(second.failure) || status.lifecycle === "failed") {
          return yield* Effect.fail(unavailableFailure(operation, second.failure));
        }
        return yield* Effect.fail(second.failure);
      }),
    );

  const stop = mutex.withPermit(
    Effect.gen(function* () {
      if (browser === undefined) {
        preferredTabUrl = undefined;
        status = { ...status, lifecycle: "stopped", selectedTabId: undefined, error: undefined };
        return status;
      }
      status = { ...status, lifecycle: "stopping" };
      expectedDisconnect = true;
      activeConnection = ++connectionSequence;
      const currentBrowser = browser;
      yield* Effect.tryPromise({
        try: () => currentBrowser.close(),
        catch: (cause) => failure("stop", cause),
      });
      browser = undefined;
      tabs = new Map();
      selectedTabId = undefined;
      preferredTabUrl = undefined;
      status = { ...status, lifecycle: "stopped", selectedTabId: undefined, error: undefined };
      return status;
    }).pipe(Effect.tapError(() => Effect.sync(() => setFailed()))),
  );

  yield* Effect.addFinalizer(() => Effect.ignore(stop));

  const service: ChromeAutomation["Service"] = {
    start: () => start,
    stop: () => stop,
    status: () => Effect.succeed({ ...status, selectedTabId }),
    listTabs: () =>
      action("tabs", () =>
        Effect.gen(function* () {
          const managed = yield* refreshTabs();
          return yield* Effect.forEach(managed.values(), tabInfo);
        }),
      ),
    selectTab: (tabId) =>
      action("selectTab", () =>
        Effect.gen(function* () {
          yield* refreshTabs();
          const tab = tabs.get(tabId);
          if (tab === undefined) {
            return yield* Effect.fail(
              new ChromeAutomationError("selectTab", `Unknown tab ${tabId}.`),
            );
          }
          selectedTabId = tabId;
          status = { ...status, selectedTabId };
          return yield* tabInfo(tab);
        }),
      ),
    navigate: (url, options = {}) =>
      action("navigate", () =>
        Effect.gen(function* () {
          const tab = yield* selectedTab();
          yield* Effect.tryPromise({
            try: () =>
              tab.page.goto(url, {
                waitUntil: options.waitUntil ?? "load",
                timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              }),
            catch: (cause) => failure("navigate", cause),
          });
          tab.refs = new Map();
          return yield* tabInfo(tab);
        }),
      ),
    snapshot: () =>
      action("snapshot", () =>
        Effect.gen(function* () {
          const tab = yield* selectedTab();
          const snapshot = yield* Effect.tryPromise({
            try: () => tab.page.snapshot(),
            catch: (cause) => failure("snapshot", cause),
          });
          tab.refs = new Map(snapshot.refs.map((ref) => [ref.ref, ref.selector]));
          return {
            ...snapshot,
            accessibilityTree: truncate(snapshot.accessibilityTree),
            dom: truncate(snapshot.dom),
            tabId: tab.id,
          };
        }),
      ),
    click: (target) =>
      action("click", () =>
        Effect.gen(function* () {
          const tab = yield* selectedTab();
          const selector = yield* Effect.try({
            try: () => targetSelector(target, tab.refs),
            catch: (cause) =>
              cause instanceof ChromeAutomationError ? cause : failure("target", cause),
          });
          yield* Effect.tryPromise({
            try: () => tab.page.click(selector),
            catch: (cause) => failure("click", cause),
          });
          tab.refs = new Map();
        }),
      ),
    fill: (target, value) =>
      action("fill", () =>
        Effect.gen(function* () {
          const tab = yield* selectedTab();
          const selector = yield* Effect.try({
            try: () => targetSelector(target, tab.refs),
            catch: (cause) =>
              cause instanceof ChromeAutomationError ? cause : failure("target", cause),
          });
          yield* Effect.tryPromise({
            try: () => tab.page.fill(selector, value),
            catch: (cause) => failure("fill", cause),
          });
          tab.refs = new Map();
        }),
      ),
    type: (target, value) =>
      action("type", () =>
        Effect.gen(function* () {
          const tab = yield* selectedTab();
          const selector = yield* Effect.try({
            try: () => targetSelector(target, tab.refs),
            catch: (cause) =>
              cause instanceof ChromeAutomationError ? cause : failure("target", cause),
          });
          yield* Effect.tryPromise({
            try: () => tab.page.type(selector, value),
            catch: (cause) => failure("type", cause),
          });
          tab.refs = new Map();
        }),
      ),
  };

  return ChromeAutomation.of(service);
});

export const layer = Layer.effect(ChromeAutomation, make());
export const layerWithOptions = (options: ChromeAutomationOptions) =>
  Layer.effect(ChromeAutomation, make(options));
