// Parent-run real acceptance against an already running isolated dev environment.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { toSafeThreadAttachmentSegment } from "../apps/server/src/attachmentStore.ts";
import { validatePcmWav, watchCallReceipts } from "./lib/otis-call-evidence.mjs";

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
    "Use a fresh isolated chat. Select the model and effort in T3, then pass --base-dir --origin --thread-url --thread-id --instance --wav --browser --expect-tool. Optional: --model --effort --disconnect-at upload|delivery|speech --reload-after-save --hang-up-after-delivery --output. See docs/otis-call/handoff-phase1.md.",
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
const timeout = Number(values["timeout-ms"] ?? 600000);
NodeAssert.ok(Number.isFinite(timeout) && timeout > 0, "Invalid acceptance timeout.");
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
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.grantPermissions(["microphone"], { origin: origin.origin });
const page = await context.newPage();
page.setDefaultTimeout(timeout);
const report = {
  source: "parent-run recorded microphone, real local speech and ordinary T3 provider",
  requestedModel: model,
  requestedEffort: effort,
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
  timingsMs: {
    uploadAcknowledgment: null,
    transcript: null,
    delivery: null,
    firstRenderedText: null,
    firstScheduledAudio: null,
  },
  callId: null,
  utteranceId: null,
  status: "failed",
  error: null,
};
let uploaded;
let delivered;
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
};
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
  if (event.type === "item.completed" && payload.status === "completed") {
    const name = payload.data?.toolName;
    if (
      typeof name === "string" &&
      (name === values["expect-tool"] || name.endsWith(`__${values["expect-tool"]}`))
    ) {
      report.otisToolCompleted = true;
      mark("otisToolCompleted", Date.parse(event.createdAt));
    }
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
    if (!response.ok()) return;
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
    window.__otisCallEvidence = { firstTextAt: null, firstAudioAt: null };
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__otisCallEvidence.firstAudioAt ??= Date.now();
      return original.apply(this, args);
    };
    new MutationObserver(() => {
      for (const row of document.querySelectorAll('[data-message-role="assistant"]'))
        if (
          !existing.has(row.getAttribute("data-message-id")) &&
          row.querySelector("[data-assistant-message-body]")?.textContent.trim()
        )
          window.__otisCallEvidence.firstTextAt ??= Date.now();
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
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
  await page.getByRole("button", { name: "End call", exact: true }).last().click();
  await receipt;
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
  await page.goto(threadUrl.href);
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
  const attention = page
    .getByRole("region", { name: "Otis call", exact: true })
    .getByRole("alert")
    .waitFor()
    .then(() => {
      throw new Error("Call needs attention.");
    });
  await Promise.race([receipts.completion, attention, expired]);
  await receipts.drain();
  await Promise.race([deliveredReceipt, expired]);
  if (!values["hang-up-after-delivery"])
    await page.waitForFunction(
      () => window.__otisCallEvidence?.firstTextAt && window.__otisCallEvidence?.firstAudioAt,
      null,
      { polling: "raf", timeout },
    );
  const observed = await page.evaluate(() => window.__otisCallEvidence);
  await page.screenshot({ path: NodePath.join(output, "phone-call.png"), fullPage: true });
  await Promise.all(responseTasks);
  NodeAssert.ok(uploaded && delivered?.deliveredAt, "Raw or delivery acknowledgment is missing.");
  const callPath = NodePath.join(home, "userdata/voice/calls", uploaded.callId);
  const raw = JSON.parse(
    await NodeFSP.readFile(NodePath.join(callPath, `${uploaded.utteranceId}.raw.json`), "utf8"),
  );
  const pcm = await NodeFSP.readFile(NodePath.join(callPath, `${uploaded.utteranceId}.pcm`));
  const transcript = JSON.parse(
    await NodeFSP.readFile(
      NodePath.join(callPath, `${uploaded.utteranceId}.transcript.json`),
      "utf8",
    ),
  );
  NodeAssert.equal(NodeCrypto.createHash("sha256").update(pcm).digest("hex"), raw.sha256);
  NodeAssert.equal(pcm.toString("base64"), uploaded.audio);
  NodeAssert.equal(raw.bytes, pcm.length);
  NodeAssert.equal(transcript.text, delivered.text);
  report.rawVerified = true;
  report.rawSha256 = raw.sha256;
  report.rawBytes = raw.bytes;
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
  const end = Date.parse(uploaded.endedAt);
  for (const name of ["uploadAcknowledgment", "transcript", "delivery"])
    report.timingsMs[name] = report.stages[name] === undefined ? null : report.stages[name] - end;
  report.timingsMs.firstRenderedText =
    observed.firstTextAt === null ? null : observed.firstTextAt - end;
  report.timingsMs.firstScheduledAudio =
    observed.firstAudioAt === null ? null : observed.firstAudioAt - end;
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
  report.error =
    error instanceof NodeAssert.AssertionError
      ? error.message
      : "Acceptance stopped. Inspect this isolated chat and its private evidence.";
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  receipts.close();
  if (!report.closedAcknowledged)
    await close().catch(() => {
      report.status = "failed";
      report.error ??= "Hang-up was not acknowledged. Retain the isolated data.";
      process.exitCode = 1;
    });
  await Promise.all(responseTasks);
  await NodeFSP.writeFile(NodePath.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
