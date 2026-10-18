// Parent-run real acceptance against an already running isolated dev environment.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { toSafeThreadAttachmentSegment } from "../apps/server/src/attachmentStore.ts";
import {
  validatePcmWav,
  watchCallReceipts,
  completedOtisTool,
  callTimings,
  verifyCallRaw,
} from "./lib/otis-call-evidence.mjs";

const { values } = NodeUtil.parseArgs({
  options: {
    ...Object.fromEntries(
      [
        "base-dir",
        "origin",
        "thread-url",
        "thread-id",
        "wav",
        "browser",
        "output",
        "instance",
        "model",
        "effort",
        "expect-tool",
        "timeout-ms",
        "width",
        "disconnect-at",
      ].map((name) => [name, { type: "string" }]),
    ),
    ...Object.fromEntries(
      ["help", "disconnect", "reload-after-save", "hang-up-after-delivery"].map((name) => [
        name,
        { type: "boolean", default: false },
      ]),
    ),
  },
});
if (values.help) {
  console.log(
    "Use a fresh approval-required isolated chat. Select the model and effort in T3, then pass --base-dir --origin --thread-url --thread-id --instance --wav --browser --expect-tool. Optional: --model --effort --width 375|390 --timeout-ms (default 900000) --disconnect-at upload|delivery|speech --reload-after-save --hang-up-after-delivery --output. Progress goes to stderr. See docs/otis-call/handoff-phase1.md for tool approvals.",
  );
  process.exit(0);
}
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
for (const name of [
  "base-dir",
  "origin",
  "thread-url",
  "thread-id",
  "wav",
  "browser",
  "instance",
  "expect-tool",
])
  NodeAssert.ok(values[name], `Missing --${name}`);
const home = NodePath.resolve(values["base-dir"]);
NodeAssert.equal(
  home.toLowerCase(),
  NodePath.resolve(root, ".t3-call-acceptance").toLowerCase(),
  "Use this worktree's .t3-call-acceptance home.",
);
const origin = new URL(values.origin);
NodeAssert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "Use an isolated loopback dev origin.",
);
NodeAssert.ok(
  !origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === "/",
  "Pass a bare dev origin.",
);
const threadUrl = new URL(values["thread-url"], origin);
NodeAssert.equal(threadUrl.origin, origin.origin, "The chat must belong to the dev origin.");
const output = NodePath.resolve(values.output ?? NodePath.join(root, ".logs/otis-call/acceptance"));
const relative = NodePath.relative(NodePath.join(root, ".logs"), output);
NodeAssert.ok(
  !relative.startsWith("..") && !NodePath.isAbsolute(relative),
  "Keep private evidence under .logs.",
);
await NodeFSP.mkdir(output, { recursive: true });
const wav = NodePath.resolve(values.wav);
const wavFormat = validatePcmWav(await NodeFSP.readFile(wav));
// Router startup alone may take 600 seconds. Leave time for speech, tools and playback.
const timeout = Number(values["timeout-ms"] ?? 900000);
NodeAssert.ok(Number.isFinite(timeout) && timeout > 0, "Invalid acceptance timeout.");
const width = Number(values.width ?? 390);
NodeAssert.ok([375, 390].includes(width), "Use --width 375 or 390.");
const model = values.model ?? "claude-haiku-5-5";
const effort = values.effort ?? "medium";
const disconnectAt = values["disconnect-at"] ?? (values.disconnect ? "upload" : null);
NodeAssert.ok(
  disconnectAt === null || ["upload", "delivery", "speech"].includes(disconnectAt),
  "Invalid --disconnect-at.",
);
NodeAssert.ok(
  !(values["hang-up-after-delivery"] && disconnectAt === "speech"),
  "Speech-disconnect and early hang-up are separate runs.",
);
function cli(...args) {
  try {
    return NodeChildProcess.execFileSync(
      process.execPath,
      ["apps/server/src/bin.ts", ...args, "--base-dir", home],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw new Error("Isolated dev CLI request failed. Authentication output was withheld.");
  }
}
const progressStages = new Set();
const progress = (name) => {
  if (progressStages.has(name)) return;
  progressStages.add(name);
  process.stderr.write(`[Otis Call] ${name}\n`);
};
progress("pair");
const baseline = JSON.parse(cli("agent", "snapshot", "--thread", values["thread-id"]));
NodeAssert.ok(
  baseline.thread && baseline.thread.latestTurn == null,
  "Use a fresh disposable chat for each run.",
);
const pairing = cli("pair").match(/https?:\/\/[^\s]+\/pair#token=[^\s]+/)?.[0];
NodeAssert.ok(
  pairing && new URL(pairing).origin === origin.origin,
  "Could not obtain a pairing URL for this dev origin.",
);
const require = NodeModule.createRequire(new URL("../apps/server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const browser = await chromium.launch({
  executablePath: NodePath.resolve(values.browser),
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
  ],
});
const context = await browser.newContext({ viewport: { width, height: 844 } });
await context.grantPermissions(["microphone"], { origin: origin.origin });
const page = await context.newPage();
page.setDefaultTimeout(timeout);
const report = {
  source: "parent-run recorded microphone, real local speech and ordinary T3 provider",
  requestedModel: model,
  requestedEffort: effort,
  viewport: { width, height: 844 },
  wavFormat,
  disconnectAt,
  responseDropped: false,
  rawVerified: false,
  rawSha256: null,
  rawBytes: null,
  exactlyOneChatMessage: false,
  requestedSelectionVerified: false,
  actualModel: null,
  sdkConfiguredEffort: null,
  providerAttestedEffort: null,
  otisToolCompleted: false,
  turnCompleted: false,
  closedAcknowledged: false,
  reloaded: false,
  chatCompletedAfterHangUp: false,
  stages: {},
  timingsMs: callTimings({}),
  callAlert: null,
  callState: null,
  voiceStates: [],
  failureKind: null,
  errorDetail: null,
  closeError: null,
  rawVerificationError: null,
  failedVoiceRequests: [],
  callId: null,
  utteranceId: null,
  status: "failed",
  error: null,
};
let uploaded;
let delivered;
let rawCheck;
let resolveUploaded;
let resolveDelivered;
const uploadedReceipt = new Promise((resolve) => {
  resolveUploaded = resolve;
});
const deliveredReceipt = new Promise((resolve) => {
  resolveDelivered = resolve;
});
const responseTasks = new Set();
const mark = (name, at = Date.now()) => {
  report.stages[name] ??= at;
  report.timingsMs = callTimings(report.stages);
  const label = {
    firstRenderedText: "first text",
    firstScheduledAudio: "first audio",
  }[name];
  if (label) progress(label);
};
await page.exposeFunction("__otisCallMark", (name, at) => mark(name, at));
const segment = toSafeThreadAttachmentSegment(values["thread-id"]);
NodeAssert.ok(segment, "Invalid disposable thread ID.");
const log = NodePath.join(home, "userdata/logs/provider", `events.${segment}.log`);
const receipts = await watchCallReceipts(log, values["thread-id"], (event) => {
  const payload = event.payload ?? {};
  if (event.type === "session.configured") {
    const config = payload.config ?? {};
    if (typeof config.effort === "string") report.sdkConfiguredEffort = config.effort;
    if (config.type === "system" && config.subtype === "init") {
      if (typeof config.model === "string") report.actualModel = config.model;
      if (typeof config.effort === "string") report.providerAttestedEffort = config.effort;
    }
  }
  if (event.type === "turn.started") mark("turnStarted", Date.parse(event.createdAt));
  if (completedOtisTool(event, values["expect-tool"])) {
    report.otisToolCompleted = true;
    mark("otisToolCompleted", Date.parse(event.createdAt));
  }
  if (event.type === "turn.completed") {
    report.turnCompleted = payload.state === "completed";
    const actual = Object.keys(payload.modelUsage ?? {}).find(
      (name) => name === model || name.startsWith(`${model}-`),
    );
    if (actual) report.actualModel = actual;
    mark("turnCompleted", Date.parse(event.createdAt));
  }
}).catch(async (error) => {
  await browser.close();
  throw error;
});
page.on("response", (response) => {
  if (new URL(response.url()).pathname !== "/api/voice") return;
  const task = (async () => {
    const input = response.request().postDataJSON();
    if (!response.ok()) {
      report.failedVoiceRequests.push({ action: input.action, status: response.status() });
      return;
    }
    if (input.action === "call.prepare" && (await response.json()).call?.ready) progress("ready");
    if (input.action === "call.open") {
      NodeAssert.equal(
        input.options.modelSelection.instanceId,
        values.instance,
        "Select the intended provider in T3.",
      );
      NodeAssert.equal(
        input.options.modelSelection.model,
        model,
        "Select the intended model in T3.",
      );
      NodeAssert.equal(
        input.options.modelSelection.options?.find((option) => option.id === "effort")?.value ??
          "default",
        effort,
        "Select the intended thinking setting in T3.",
      );
      report.requestedSelectionVerified = true;
    }
    if (input.action === "call.upload" && input.utteranceId === uploaded?.utteranceId) {
      mark("uploadAcknowledgment");
      rawCheck ??= verifyCallRaw(home, uploaded)
        .then((proof) => Object.assign(report, proof))
        .catch(() => {
          report.rawVerificationError = "PC raw archive did not match the acknowledged upload.";
        });
      resolveUploaded();
    }
    if (input.action === "call.transcribe") mark("transcript");
    if (input.action === "call.deliver" && !delivered) {
      delivered = (await response.json()).utterance;
      mark("delivery");
      resolveDelivered();
    }
    if (input.action === "call.close") {
      report.closedAcknowledged = true;
      mark("closed");
    }
  })().catch((error) => {
    report.error = error.message;
  });
  responseTasks.add(task);
  void task.finally(() => responseTasks.delete(task));
});
await page.route("**/api/voice", async (route) => {
  const input = route.request().postDataJSON();
  const stage = {
    "call.open": "call open",
    "call.prepare": "prepare",
    "call.upload": "upload",
    "call.transcribe": "transcript",
    "call.deliver": "delivery",
    "call.close": "close",
  }[input.action];
  if (stage) progress(stage);
  if (input.action === "call.open") {
    const selection = input.options?.modelSelection;
    if (
      selection?.instanceId !== values.instance ||
      selection.model !== model ||
      (selection.options?.find((option) => option.id === "effort")?.value ?? "default") !== effort
    ) {
      report.error =
        "Select the intended provider, model and thinking setting in T3 before acceptance.";
      await route.fulfill({ status: 409, contentType: "text/plain", body: report.error });
      return;
    }
  }
  if (input.action === "call.upload" && !uploaded) {
    uploaded = input;
    report.callId = input.callId;
    report.utteranceId = input.utteranceId;
    mark("speechEnded", Date.parse(input.endedAt));
  }
  const target = { upload: "call.upload", delivery: "call.deliver", speech: "call.speak" }[
    disconnectAt
  ];
  if (input.action === target && !report.responseDropped) {
    report.responseDropped = true;
    const saved = await route.fetch();
    NodeAssert.ok(saved.ok(), "Server must accept the stage before its response is discarded.");
    await route.abort("connectionreset");
    return;
  }
  await route.continue();
});
async function instrument() {
  await page.evaluate(() => {
    const existing = new Set(
      [...document.querySelectorAll('[data-message-role="assistant"]')].map((node) =>
        node.getAttribute("data-message-id"),
      ),
    );
    window.__otisCallEvidence = { firstTextAt: null, firstAudioAt: null, voiceStates: [] };
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (window.__otisCallEvidence.firstAudioAt === null) {
        window.__otisCallEvidence.firstAudioAt = Date.now();
        void window.__otisCallMark("firstScheduledAudio", window.__otisCallEvidence.firstAudioAt);
      }
      return original.apply(this, args);
    };
    new MutationObserver(() => {
      const state = document.querySelector("[data-voice-state]")?.getAttribute("data-voice-state");
      const states = window.__otisCallEvidence.voiceStates;
      if (state && states.at(-1)?.state !== state) states.push({ at: Date.now(), state });
      for (const row of document.querySelectorAll('[data-message-role="assistant"]'))
        if (
          !existing.has(row.getAttribute("data-message-id")) &&
          row.querySelector("[data-assistant-message-body]")?.textContent.trim()
        ) {
          if (window.__otisCallEvidence.firstTextAt === null) {
            window.__otisCallEvidence.firstTextAt = Date.now();
            void window.__otisCallMark("firstRenderedText", window.__otisCallEvidence.firstTextAt);
          }
        }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-voice-state"],
    });
  });
}
async function start() {
  await page.getByRole("button", { name: "Call Otis", exact: true }).click();
  await page.getByRole("button", { name: "Start call or recover saved call", exact: true }).click();
}
async function close() {
  const receipt = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/voice" &&
      response.request().postDataJSON()?.action === "call.close" &&
      response.ok(),
    { timeout: 10000 },
  );
  await Promise.all([
    receipt,
    page.getByRole("button", { name: "End call", exact: true }).last().click(),
  ]);
}
let deadline;
const expired = new Promise((_, reject) => {
  deadline = setTimeout(
    () => reject(new Error("Acceptance deadline expired. Retain the isolated chat and logs.")),
    timeout,
  );
});
try {
  await page.goto(pairing);
  await page.waitForURL((url) => url.pathname !== "/pair");
  progress("thread open");
  await page.goto(threadUrl.href);
  await page.getByRole("button", { name: "Choose model", exact: true }).waitFor();
  await page.getByRole("button", { name: "Call Otis", exact: true }).waitFor();
  await instrument();
  await start();
  if (disconnectAt)
    await page.getByRole("button", { name: "Retry saved speech", exact: true }).click();
  if (values["reload-after-save"]) {
    await Promise.race([uploadedReceipt, expired]);
    await page.reload();
    await instrument();
    await start();
    report.reloaded = true;
  }
  if (values["hang-up-after-delivery"]) {
    await Promise.race([deliveredReceipt, expired]);
    await close();
  }
  const attention = page.getByRole("region", { name: "Otis call", exact: true }).getByRole("alert");
  const attentionFailure = attention.waitFor().then(async () => {
    report.callAlert = await attention.innerText();
    throw new Error("Call displayed an alert. See callAlert and phone-call.png.");
  });
  await Promise.race([receipts.completion, attentionFailure, expired]);
  await receipts.drain();
  await Promise.race([deliveredReceipt, expired]);
  if (!values["hang-up-after-delivery"])
    await Promise.race([
      attentionFailure,
      expired,
      page.waitForFunction(
        () => window.__otisCallEvidence?.firstTextAt && window.__otisCallEvidence?.firstAudioAt,
        null,
        { polling: "raf", timeout },
      ),
    ]);
  await page.screenshot({ path: NodePath.join(output, "phone-call.png"), fullPage: true });
  await Promise.all(responseTasks);
  NodeAssert.ok(uploaded && delivered?.deliveredAt, "Raw or delivery acknowledgment is missing.");
  const callPath = NodePath.join(home, "userdata/voice/calls", uploaded.callId);
  const transcript = JSON.parse(
    await NodeFSP.readFile(
      NodePath.join(callPath, `${uploaded.utteranceId}.transcript.json`),
      "utf8",
    ),
  );
  NodeAssert.ok(transcript.text === delivered.text, "Saved transcript and delivery disagree.");
  await rawCheck;
  NodeAssert.ok(report.rawVerified, "PC raw verification failed.");
  const snapshot = await page.evaluate(async (threadId) => {
    const response = await fetch(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}?turnLimit=1`,
      { credentials: "include" },
    );
    if (!response.ok) throw new Error("Readback failed");
    return response.json();
  }, values["thread-id"]);
  report.exactlyOneChatMessage =
    snapshot.thread.messages.filter((message) => message.id === delivered.messageId).length === 1;
  NodeAssert.ok(
    report.exactlyOneChatMessage &&
      report.otisToolCompleted &&
      report.turnCompleted &&
      report.requestedSelectionVerified,
    "Missing persisted chat, selected model, completed Otis tool, or successful turn evidence.",
  );
  NodeAssert.ok(
    report.actualModel === model || report.actualModel?.startsWith(`${model}-`),
    "The provider did not attest the requested model.",
  );
  NodeAssert.ok(
    effort === "default" || report.sdkConfiguredEffort === effort,
    "The SDK did not report the requested thinking setting.",
  );
  NodeAssert.ok(
    report.providerAttestedEffort === null || report.providerAttestedEffort === effort,
    "Provider effort differs from the requested setting.",
  );
  NodeAssert.ok(!disconnectAt || report.responseDropped, "Disconnect was not injected.");
  report.chatCompletedAfterHangUp =
    !!values["hang-up-after-delivery"] && report.stages.turnCompleted > report.stages.closed;
  if (values["hang-up-after-delivery"])
    NodeAssert.ok(
      report.chatCompletedAfterHangUp,
      "The chat completed before hang-up; repeat with a longer read-only operation to prove continuation.",
    );
  NodeAssert.ok(!report.error, "An observed request failed selection validation.");
  report.status = "passed-observations-needs-parent-acceptance";
} catch (error) {
  report.failureKind = error instanceof Error ? error.name : "UnknownError";
  report.errorDetail =
    error instanceof Error
      ? error.name === "SyntaxError"
        ? "Malformed receipt or browser response."
        : error.message
            .split("\n")[0]
            .replace(/https?:\/\/\S+/g, "[URL withheld]")
            .replace(/token=\S+/gi, "token=[withheld]")
            .slice(0, 400)
      : null;
  report.error = report.callAlert
    ? "Call displayed an alert. See callAlert and phone-call.png."
    : error instanceof NodeAssert.AssertionError
      ? error.message
      : error instanceof Error && error.message.startsWith("Acceptance deadline")
        ? error.message
        : "Acceptance browser or receipt step failed. See failureKind, callState and private screenshot.";
  // Voice failure does not stop the chat. Retain its independently completed receipts.
  if (delivered && !report.turnCompleted)
    await Promise.race([receipts.completion, expired]).catch(() => {});
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await Promise.all(responseTasks);
  await receipts.drain().catch(() => {});
  receipts.close();
  await rawCheck;
  const evidence = await page
    .evaluate(() => {
      const call = document.querySelector("[data-voice-state]");
      return {
        state: call?.getAttribute("data-voice-state") ?? null,
        alert: call?.querySelector('[role="alert"]')?.textContent ?? null,
        timing: window.__otisCallEvidence,
      };
    })
    .catch(() => null);
  report.callState = evidence?.state ?? report.callState;
  report.voiceStates = evidence?.timing?.voiceStates ?? [];
  report.callAlert ??= evidence?.alert ?? null;
  if (evidence?.timing?.firstTextAt != null) mark("firstRenderedText", evidence.timing.firstTextAt);
  if (evidence?.timing?.firstAudioAt != null)
    mark("firstScheduledAudio", evidence.timing.firstAudioAt);
  await page
    .screenshot({ path: NodePath.join(output, "phone-call.png"), fullPage: true })
    .catch(() => {});
  if (delivered) {
    const count = await page
      .evaluate(
        async ({ threadId, messageId }) => {
          const response = await fetch(
            `/api/orchestration/threads/${encodeURIComponent(threadId)}?turnLimit=1`,
            { credentials: "include" },
          );
          if (!response.ok) throw new Error("Readback failed");
          const snapshot = await response.json();
          return snapshot.thread.messages.filter((message) => message.id === messageId).length;
        },
        { threadId: values["thread-id"], messageId: delivered.messageId },
      )
      .catch(() => null);
    report.exactlyOneChatMessage = count === 1;
  }
  if (!report.closedAcknowledged)
    await close().catch((error) => {
      report.closeError = error instanceof Error ? error.name : "UnknownError";
      report.status = "failed";
      report.error ??= "Hang-up was not acknowledged. Retain the isolated data.";
      process.exitCode = 1;
    });
  await Promise.all(responseTasks);
  report.timingsMs = callTimings(report.stages);
  await NodeFSP.writeFile(NodePath.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
