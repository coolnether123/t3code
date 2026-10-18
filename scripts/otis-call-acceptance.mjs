// Parent-run acceptance candidate, not yet exercised. See docs/otis-call/architecture.md.
// Uses an existing disposable T3 server and chat; never launches or reconfigures one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: Object.fromEntries([
  "base-dir", "origin", "thread-url", "thread-id", "wav", "browser", "output",
  "instance", "model", "effort", "expect-tool", "timeout-ms",
].map((name) => [name, { type: "string" }]).concat([["disconnect", { type: "boolean", default: false }]])) });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["base-dir", "origin", "thread-url", "thread-id", "wav", "browser", "instance", "expect-tool"]) {
  assert(values[name], `Missing --${name}`);
}
const home = resolve(values["base-dir"]);
assert.equal(home.toLowerCase(), resolve(root, ".t3-call-acceptance").toLowerCase(), "Use only this worktree's .t3-call-acceptance home.");
const origin = new URL(values.origin);
assert(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "Acceptance targets an isolated loopback dev origin.");
const threadUrl = new URL(values["thread-url"], origin);
assert.equal(threadUrl.origin, origin.origin, "Thread must belong to the dev origin.");
const output = resolve(values.output ?? resolve(root, ".logs/otis-call/acceptance"));
const inside = relative(resolve(root, ".logs"), output);
assert(!inside.startsWith("..") && !isAbsolute(inside), "Keep private acceptance evidence below this worktree's .logs.");
await mkdir(output, { recursive: true });
const wav = resolve(values.wav);
const header = await readFile(wav);
assert.equal(header.subarray(0, 4).toString(), "RIFF", "Use a PCM WAV recording.");
assert.equal(header.subarray(8, 12).toString(), "WAVE", "Use a PCM WAV recording.");
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const deadline = Number(values["timeout-ms"] ?? 600000);
const model = values.model ?? "claude-haiku-5-5";
const effort = values.effort ?? "medium";
function cli(...args) {
  try {
    return execFileSync(process.execPath, ["apps/server/src/bin.ts", ...args, "--base-dir", home], {
      cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Dev CLI request failed. Inspect the isolated server locally; captured authentication output was withheld.");
  }
}
const baseline = JSON.parse(cli("agent", "snapshot", "--thread", values["thread-id"]));
assert(baseline.thread, "Create the disposable acceptance chat first.");
const priorActivities = new Set(baseline.thread.activities.map((entry) => entry.id));
const pairingOutput = cli("pair");
const pairingUrl = pairingOutput.match(/https?:\/\/[^\s]+\/pair#token=[^\s]+/)?.[0];
assert(pairingUrl && new URL(pairingUrl).origin === origin.origin, "Could not obtain a pairing URL for the specified dev origin. Nothing was printed or saved.");
const browser = await chromium.launch({ executablePath: resolve(values.browser), headless: true, args: [
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${wav}%noloop`,
] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.grantPermissions(["microphone"], { origin: origin.origin });
const page = await context.newPage();
page.setDefaultTimeout(deadline);
const report = { source: "parent-run real engines and provider; prerecorded microphone input", model, effort,
  disconnectRequested: values.disconnect, uploadResponseDropped: false, rawVerified: false,
  exactlyOneChatMessage: false, requestedModelVerified: false, providerSessionModel: null,
  otisToolCompleted: false, closedAcknowledged: false, timingsMs: { transcript: null, firstRenderedAssistant: null, firstScheduledAudio: null },
  callId: null, utteranceId: null, status: "failed", error: null };
let uploaded;
let delivered;
const responseTasks = new Set();
page.on("response", (response) => {
  if (new URL(response.url()).pathname !== "/api/voice") return;
  const task = (async () => {
    const request = response.request().postDataJSON();
    if (!response.ok()) return;
    if (request.action === "call.close") report.closedAcknowledged = true;
    if (request.action === "call.open") {
      assert.equal(request.options.modelSelection.instanceId, values.instance, "Wrong provider instance selected in the composer.");
      assert.equal(request.options.modelSelection.model, model);
      report.requestedModelVerified = true;
    }
    if (request.action === "call.transcribe" && report.timingsMs.transcript === null && uploaded) {
      report.timingsMs.transcript = Date.now() - Date.parse(uploaded.endedAt);
    }
    if (request.action === "call.deliver" && !delivered) delivered = (await response.json()).utterance;
  })().catch((error) => { report.error = error.message; });
  responseTasks.add(task);
  void task.finally(() => responseTasks.delete(task));
});
await page.route("**/api/voice", async (route) => {
  const request = route.request().postDataJSON();
  if (request.action === "call.upload" && !uploaded) {
    uploaded = request;
    report.callId = request.callId;
    report.utteranceId = request.utteranceId;
    if (values.disconnect) {
      const result = await route.fetch();
      assert(result.ok(), "Server must save the recording before dropping its acknowledgment.");
      report.uploadResponseDropped = true;
      await route.abort("connectionreset");
      return;
    }
  }
  await route.continue();
});
try {
  await page.goto(pairingUrl);
  await page.waitForURL((url) => url.pathname !== "/pair");
  await page.goto(threadUrl.href);
  await page.getByRole("button", { name: "Call Otis", exact: true }).waitFor();
  await page.evaluate(() => {
    const existing = new Set([...document.querySelectorAll('[data-message-role="assistant"]')].map((node) => node.getAttribute("data-message-id")));
    window.__otisCallEvidence = { firstTextAt: null, firstAudioAt: null };
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__otisCallEvidence.firstAudioAt ??= Date.now();
      return original.apply(this, args);
    };
    new MutationObserver(() => {
      for (const node of document.querySelectorAll('[data-message-role="assistant"]')) {
        if (!existing.has(node.getAttribute("data-message-id")) && node.textContent.trim()) window.__otisCallEvidence.firstTextAt ??= Date.now();
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.getByRole("button", { name: "Call Otis", exact: true }).click();
  await page.getByLabel("Call model", { exact: true }).fill(model);
  await page.getByLabel("Call thinking", { exact: true }).selectOption(effort);
  await page.getByRole("button", { name: "Start call or recover saved call", exact: true }).click();
  if (values.disconnect) await page.getByRole("button", { name: "Retry saved speech", exact: true }).click();
  await page.waitForFunction(() => window.__otisCallEvidence?.firstTextAt && window.__otisCallEvidence?.firstAudioAt, null, { timeout: deadline });
  await page.screenshot({ path: resolve(output, "phone-call.png"), fullPage: true });
  const observed = await page.evaluate(() => window.__otisCallEvidence);
  assert(uploaded, "No PCM utterance reached the server.");
  await Promise.all([...responseTasks]);
  assert(delivered?.deliveredAt, "Delivery acknowledgment is missing.");
  const speechEnd = Date.parse(uploaded.endedAt);
  report.timingsMs.firstRenderedAssistant = observed.firstTextAt - speechEnd;
  report.timingsMs.firstScheduledAudio = observed.firstAudioAt - speechEnd;
  const callPath = resolve(home, "userdata/voice/calls", uploaded.callId);
  const raw = JSON.parse(await readFile(resolve(callPath, `${uploaded.utteranceId}.raw.json`), "utf8"));
  const pcm = await readFile(resolve(callPath, `${uploaded.utteranceId}.pcm`));
  const transcript = JSON.parse(await readFile(resolve(callPath, `${uploaded.utteranceId}.transcript.json`), "utf8"));
  assert.equal(createHash("sha256").update(pcm).digest("hex"), raw.sha256);
  assert.equal(pcm.toString("base64"), uploaded.audio);
  assert.equal(raw.bytes, pcm.length);
  assert.equal(transcript.text, delivered.text);
  report.rawVerified = true;
  const snapshot = JSON.parse(cli("agent", "snapshot", "--thread", values["thread-id"]));
  report.providerSessionModel = snapshot.thread.session?.model ?? null;
  report.exactlyOneChatMessage = snapshot.thread.messages.filter((message) => message.id === delivered.messageId).length === 1;
  report.otisToolCompleted = snapshot.thread.activities.some((activity) => !priorActivities.has(activity.id) && activity.kind === "tool.completed" && JSON.stringify(activity).includes(values["expect-tool"]));
  assert(report.exactlyOneChatMessage, "Expected one persisted user message for the utterance.");
  assert(report.requestedModelVerified, "Exact model selection was not observed.");
  assert(!values.disconnect || report.uploadResponseDropped, "Requested disconnect was not injected.");
  assert(report.otisToolCompleted, "No completed expected Otis tool in bounded readback. Inspect untruncated thread evidence before acceptance.");
  assert(!report.error, "An intercepted call request failed validation.");
  report.status = "passed-client-and-storage-observations";
} catch (error) {
  report.error = error instanceof assert.AssertionError ? error.message : "Acceptance stopped. Inspect the private screenshot and running dev chat for the failure.";
  process.exitCode = 1;
} finally {
  // Persist recordings through the normal hang-up path, even after a failed assertion.
  const closeResponse = page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== "/api/voice") return false;
    return response.request().postDataJSON()?.action === "call.close" && response.ok();
  }, { timeout: 10000 }).catch(() => null);
  await page.getByRole("button", { name: "End call", exact: true }).last().click({ timeout: 5000 }).catch(() => {});
  if (!(await closeResponse)) {
    report.status = "failed";
    report.error ??= "Hang-up was not acknowledged. Retain the dev data and inspect the call before retrying.";
    process.exitCode = 1;
  }
  await Promise.all([...responseTasks]);
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
