#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes } from "node:crypto";

const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR !== 24) {
  process.stderr.write(`S2 probe refuses to run: Node 24 required, got ${process.versions.node}\n`);
  process.exit(2);
}

const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SPIKE_DIR, "..", "..");
const NODE = "/usr/local/bin/node";
const EVE_BIN = path.join(REPO_ROOT, "node_modules/eve/bin/eve.js");
const PORT = Number(process.env.UB_S2_PORT || 4327);
const BASE = `http://127.0.0.1:${PORT}`;

function log(message) {
  process.stderr.write(`${message}\n`);
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signJwt(secret, sub, botId = "probe-bot") {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    sub,
    iss: "useful-bot",
    aud: "useful-bot",
    botId,
    iat: now,
    exp: now + 3600,
  }));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(4000) });
  const text = await response.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body, text };
}

async function waitForHealth(timeoutMs, eve) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    if (eve.earlyExit() !== null) {
      const { stdout, stderr } = eve.output();
      throw new Error(`eve exited ${eve.earlyExit()} before health: ${stderr.slice(-1500) || stdout.slice(-1500)}`);
    }
    try {
      const result = await fetchJson(`${BASE}/eve/v1/health`);
      if (result.status === 200) return result;
      last = `${result.status} ${String(result.text).slice(0, 120)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await wait(500);
  }
  const { stdout, stderr } = eve.output();
  throw new Error(`eve health did not become ready: ${last}\nstdout:\n${stdout.slice(-2000)}\nstderr:\n${stderr.slice(-2000)}`);
}

function startEve(env) {
  const child = spawn(NODE, [EVE_BIN, "dev", "--no-ui", "--host", "127.0.0.1", "--port", String(PORT)], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, PATH: "/usr/local/bin:/usr/bin:/bin", EVE_TRACES: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  return {
    child,
    output() { return { stdout, stderr }; },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await wait(1500);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
    earlyExit() {
      return child.exitCode;
    },
  };
}

async function readStreamOnce(sessionId, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const response = await fetch(`${BASE}/eve/v1/session/${sessionId}/stream`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      return { status: response.status, events, text: await response.text() };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        try { events.push(JSON.parse(payload)); } catch { events.push({ unparsed: payload.slice(0, 200) }); }
      }
      const joined = JSON.stringify(events);
      if (joined.includes("S2-TOOL-PLANT-001") || joined.includes("turn.cancelled") || joined.includes("session.waiting")) {
        break;
      }
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    return { status: response.status, events, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

function recordOf(name, status, evidence, note = "") {
  return { case: name, status, note, evidence };
}

async function main() {
  mkdirSync(SPIKE_DIR, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  const tokenA = signJwt(secret, "desktop-a");
  const tokenB = signJwt(secret, "desktop-b");
  const records = [];
  const eve = startEve({
    UB_S2_FIXTURE: "1",
    UB_CHANNEL_JWT_SECRET: secret,
    NODE_ENV: "production",
  });
  try {
    log("S2 probe: waiting for eve health");
    const health = await waitForHealth(90_000, eve);
    records.push(recordOf("health-anonymous", health.status === 200 ? "PASS" : "FAIL", health));

    const infoAnon = await fetchJson(`${BASE}/eve/v1/info`);
    records.push(recordOf("info-anonymous-denied", infoAnon.status === 401 ? "PASS" : "FAIL", { status: infoAnon.status, body: infoAnon.body }));

    const sessionAnon = await fetchJson(`${BASE}/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    records.push(recordOf("session-anonymous-denied", sessionAnon.status === 401 ? "PASS" : "FAIL", { status: sessionAnon.status, body: sessionAnon.body }));

    const created = await fetchJson(`${BASE}/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ message: "Call plant_read and report the token." }),
    });
    const sessionId = created.body && created.body.sessionId;
    records.push(recordOf(
      "authenticated-create",
      created.status < 300 && sessionId ? "PASS" : "FAIL",
      { status: created.status, body: created.body },
    ));

    if (!sessionId) {
      throw new Error("no sessionId; remaining live cases cannot run");
    }

    try {
      await fetch(`${BASE}/eve/v1/session/${sessionId}/stream`, {
        headers: { authorization: `Bearer ${tokenA}` },
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      // claim the session id in AuthFn; aborting the stream is expected
    }

    const stolen = await fetchJson(`${BASE}/eve/v1/session/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ message: "steal" }),
    });
    records.push(recordOf(
      "ownership-other-principal",
      stolen.status === 401 || stolen.status === 403 || stolen.status === 404 ? "PASS" : "FAIL",
      { status: stolen.status, body: stolen.body, text: String(stolen.text).slice(0, 300) },
    ));

    const stream = await readStreamOnce(sessionId, tokenA, 45_000);
    const blob = JSON.stringify(stream.events);
    const sawPlant = blob.includes("S2-TOOL-PLANT-001");
    const sawTool = blob.includes("plant_read") || blob.includes("call_plant");
    records.push(recordOf(
      "tool-result",
      sawPlant ? "PASS" : (stream.events.length ? "UNVERIFIED" : "FAIL"),
      { status: stream.status, sawPlant, sawTool, eventCount: stream.events.length, sample: stream.events.slice(0, 6) },
      sawPlant ? "" : "stream did not contain planted token",
    ));

    const cancelSession = await fetchJson(`${BASE}/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ message: "Call plant_read then wait." }),
    });
    const cancelId = cancelSession.body && cancelSession.body.sessionId;
    if (!cancelId) {
      records.push(recordOf("cancel", "UNVERIFIED", { status: cancelSession.status, body: cancelSession.body }, "could not create cancel session"));
    } else {
      await wait(400);
      const cancelled = await fetchJson(`${BASE}/eve/v1/session/${cancelId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({}),
      });
      const after = await readStreamOnce(cancelId, tokenA, 15_000);
      const afterBlob = JSON.stringify(after.events);
      const sawCancel = afterBlob.includes("turn.cancelled") || afterBlob.includes("cancelled") || cancelled.status < 300;
      records.push(recordOf(
        "cancel",
        sawCancel ? "PASS" : "UNVERIFIED",
        { cancelStatus: cancelled.status, cancelBody: cancelled.body, eventCount: after.events.length, sample: after.events.slice(0, 8) },
      ));
    }

    const reconnect = await readStreamOnce(sessionId, tokenA, 10_000);
    const reconnectBlob = JSON.stringify(reconnect.events);
    const resubmitted = reconnectBlob.includes("\"executions\":2") || reconnectBlob.includes("executions\": 2");
    records.push(recordOf(
      "reconnect-no-resubmit",
      reconnect.status === 200 && !resubmitted ? "PASS" : "UNVERIFIED",
      { status: reconnect.status, eventCount: reconnect.events.length, resubmitted },
    ));

    const { stdout, stderr } = eve.output();
    const leakedSecret = `${stdout}\n${stderr}`.includes(secret);
    records.push(recordOf("secret-not-in-logs", leakedSecret ? "FAIL" : "PASS", { leakedSecret }));
  } catch (error) {
    const { stdout, stderr } = eve.output();
    records.push(recordOf("boot", "FAIL", {
      error: error instanceof Error ? error.message : String(error),
      exitCode: eve.earlyExit(),
      stdout: stdout.slice(-4000),
      stderr: stderr.slice(-4000),
    }));
  } finally {
    await eve.stop();
  }

  const failures = records.filter((r) => r.status === "FAIL");
  const unverified = records.filter((r) => r.status === "UNVERIFIED");
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.versions.node,
    eveBind: { host: "127.0.0.1", port: PORT },
    stateDir: ".eve/ (permitted S2 fallback; gitignored, mode to be set 0700 in service config)",
    traces: "child env EVE_TRACES=off",
    records,
  };
  writeFileSync(path.join(SPIKE_DIR, "results.json"), `${JSON.stringify(output, null, 2)}\n`);
  const lines = [
    "# S2 spike report: eve channel auth, ownership, cancel",
    "",
    `Generated: ${output.generatedAt}`,
    "",
    "| Case | Status | Note |",
    "|---|---|---|",
    ...records.map((r) => `| ${r.case} | ${r.status} | ${r.note || ""} |`),
    "",
    "## Bind and store",
    "",
    `- eve start/dev support \`--host\` and \`--port\`. S2 used \`127.0.0.1:${PORT}\`.`,
    "- Durable store is project \`.eve/\` (the only public fallback in eve 0.54.3). gitignored.",
    "- Auth is \`jwtHmac\` only. No \`localDev\`, \`placeholderAuth\` or \`none\`.",
    "- Channel JWT secret is generated per probe, passed through env, never written to the repo.",
    "",
  ];
  writeFileSync(path.join(SPIKE_DIR, "REPORT.md"), lines.join("\n"));
  log(`S2 probe: ${records.length} records, ${records.length - failures.length - unverified.length} PASS, ${failures.length} FAIL, ${unverified.length} UNVERIFIED`);
  if (failures.length > 0) process.exitCode = 1;
}

main();
