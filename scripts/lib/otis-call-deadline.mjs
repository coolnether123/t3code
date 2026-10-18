import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Bound the entire acceptance run, including setup and evidence cleanup. */
export async function runAcceptanceWithDeadline({ output, report, timeoutMs, run, close }) {
  NodeFS.mkdirSync(output, { recursive: true });
  const checkpoint = () =>
    NodeFS.writeFileSync(NodePath.join(output, "report.json"), JSON.stringify(report, null, 2));
  report.status = "running";
  report.deadlineExpired = false;
  checkpoint();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      report.deadlineExpired = true;
      reject(new Error("Acceptance deadline expired. Retain the isolated chat and logs."));
    }, timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(() => run(expired, checkpoint)), expired]);
  } catch (error) {
    report.status = "failed";
    report.failureKind = error instanceof Error ? error.name : "UnknownError";
    report.error ??=
      error instanceof Error && error.message.startsWith("Acceptance deadline")
        ? error.message
        : "Acceptance setup or evidence cleanup failed. Retain the isolated chat and logs.";
    // Save before asking the browser to close. Closing can itself be the stuck operation.
    checkpoint();
    void Promise.resolve()
      .then(close)
      .catch(() => {});
  } finally {
    clearTimeout(timer);
    checkpoint();
  }
  return report.status !== "failed" && report.status !== "running";
}
