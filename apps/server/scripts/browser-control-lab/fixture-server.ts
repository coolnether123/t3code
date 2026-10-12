// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off - Standalone synthetic HTTP fixture uses Node APIs independently of the Effect service under test.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeEvents from "node:events";
import * as NodeURL from "node:url";

export interface SaveReceipt {
  readonly run: string;
  readonly payload: unknown;
  readonly delayMs: number;
}

/** Synthetic readback owner. Never points at an external account or datastore. */
export async function startFixtureServer() {
  const html = await NodeFSP.readFile(new URL("./fixture.html", import.meta.url), "utf8");
  const receipts: SaveReceipt[] = [];
  const committed = new NodeEvents.EventEmitter();
  const server = NodeHttp.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    } else if (request.method === "POST" && url.pathname === "/save") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const seed =
        typeof payload === "object" && payload !== null && "seed" in payload
          ? Number(payload.seed)
          : 0;
      const delayMs = 500 + (seed % 5) * 250;
      // Deliberate fixture latency, not a readiness sleep in the driver.
      setTimeout(() => {
        const receipt = { run: url.searchParams.get("run") ?? "manual", payload, delayMs };
        receipts.push(receipt);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ saved: true }));
        committed.emit(receipt.run, receipt);
      }, delayMs);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    receipts,
    waitForSave: (run: string) =>
      new Promise<SaveReceipt>((resolve) => committed.once(run, resolve)),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

if (
  process.argv[1] !== undefined &&
  NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const fixture = await startFixtureServer();
  console.log(`Synthetic fixture: ${fixture.origin}`);
  process.once("SIGINT", () => void fixture.close());
  process.once("SIGTERM", () => void fixture.close());
}
