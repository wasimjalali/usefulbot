#!/usr/bin/env node
/**
 * S4: prove the Composio chain end to end with the real SDK.
 *
 * Reads the Composio key from the app's own store (~/.useful-bot/connectors.json,
 * or UB_CONNECTORS_PATH), never from an argument, and never prints it. Steps:
 *
 *   1. resume or create the Tool Router session
 *   2. list the catalogue with connection status
 *   3. if the toolkit under test is not connected, print its Connect Link and
 *      wait for the browser flow to finish (up to 3 minutes)
 *   4. search for a use case restricted to connected toolkits
 *   5. execute one read-only tool
 *   6. resume the session by id from a fresh client
 *
 * Usage: /usr/local/bin/node spikes/s4/probe.mjs [toolkit] [tool] [jsonArgs]
 * Default: gmail GMAIL_FETCH_EMAILS {"max_results":1}
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR !== 24) {
  process.stderr.write(`S4 probe refuses to run: Node 24 required, got ${process.versions.node}\n`);
  process.exit(2);
}

const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SPIKE_DIR, "..", "..");
const toolkit = process.argv[2] ?? "gmail";
const tool = process.argv[3] ?? "GMAIL_FETCH_EMAILS";
const args = JSON.parse(process.argv[4] ?? '{"max_results":1}');

function log(message) {
  process.stderr.write(`${message}\n`);
}

async function main() {
  const storeMod = await import(pathToFileURL(path.join(REPO_ROOT, "shared/connectors-store.ts")).href);
  const composioMod = await import(pathToFileURL(path.join(REPO_ROOT, "shared/composio.ts")).href);
  const store = storeMod.readConnectorsStore();
  const report = { toolkit, tool, steps: {} };
  if (!store.apiKey) {
    log("no Composio key in the connectors store. Paste it in Connectors first, then rerun.");
    process.exit(3);
  }

  const t0 = Date.now();
  const session = await composioMod.connectorsSession();
  report.steps.session = { ok: true, resumed: Boolean(store.sessionId), ms: Date.now() - t0 };
  log(`session ${store.sessionId ? "resumed" : "created"} in ${report.steps.session.ms}ms`);

  const t1 = Date.now();
  const rows = await composioMod.listConnectorToolkits({ search: toolkit });
  const row = rows.find((item) => item.slug === toolkit);
  report.steps.list = { ok: Boolean(row), count: rows.length, ms: Date.now() - t1, row };
  log(`catalogue: ${rows.length} rows, ${toolkit} ${row ? (row.connected ? "connected" : "not connected") : "missing"}`);
  if (!row) throw new Error(`toolkit ${toolkit} not in catalogue`);

  if (!row.connected) {
    const t2 = Date.now();
    const link = await composioMod.authorizeConnector(toolkit, "http://127.0.0.1:4320/api/connectors/callback");
    log(`open this in a browser and approve:\n${link.redirectUrl}`);
    const deadline = Date.now() + 180_000;
    let connected = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const again = await composioMod.listConnectorToolkits({ search: toolkit });
      if (again.find((item) => item.slug === toolkit)?.connected) {
        connected = true;
        break;
      }
    }
    report.steps.authorize = { ok: connected, ms: Date.now() - t2 };
    if (!connected) throw new Error("connection not completed within 3 minutes");
    log("connected");
  }

  const t3 = Date.now();
  const search = await composioMod.searchConnectorTools(`use ${tool.toLowerCase().replace(/_/g, " ")}`);
  report.steps.search = {
    ok: search.tools.length > 0,
    ms: Date.now() - t3,
    tools: search.tools.map((hit) => hit.tool),
    guidance: search.guidance.length,
    notConnected: search.notConnected,
  };
  log(`search: ${search.tools.length} tools (${search.tools.map((hit) => hit.tool).join(", ")})`);

  const t4 = Date.now();
  const result = await composioMod.executeConnectorTool(tool, args);
  const text = JSON.stringify(result);
  report.steps.execute = {
    ok: true,
    ms: Date.now() - t4,
    bytes: text.length,
    keys: result && typeof result === "object" ? Object.keys(result) : [],
    successful: result?.successful ?? null,
    error: result?.error ?? null,
  };
  log(`execute: ${text.length} bytes, keys ${report.steps.execute.keys.join(",")}, successful=${report.steps.execute.successful}`);

  const t5 = Date.now();
  composioMod.setComposioFactory(null);
  const resumed = await composioMod.connectorsSession();
  report.steps.resume = { ok: resumed.sessionId === session.sessionId, ms: Date.now() - t5 };
  log(`resume by id: ${report.steps.resume.ok ? "same session" : "DIFFERENT session"}`);

  report.pass = Object.values(report.steps).every((step) => step.ok);
  writeFileSync(path.join(SPIKE_DIR, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  log(report.pass ? "S4 PASS" : "S4 FAIL");
  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  log(`S4 error: ${err?.message ?? err}`);
  process.exit(1);
});
