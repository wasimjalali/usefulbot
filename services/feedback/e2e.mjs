// End-to-end check of the feedback Worker against `wrangler dev` with a local D1 and simulated email.
// Usage: node e2e.mjs [out.json]. Writes every case and its result to out.json.
//
// Ways it could fail, written before the Worker, each covered below:
//  1. Bad requests get stored: wrong method, path, content type, non-JSON, oversized body.
//  2. Field validation: bad kind, empty or over-long message, bad reply email or one carrying a
//     header, non-UUID install id, wrong context types. And the edge that must pass: 4,000 emoji.
//  3. Install limit: a 6th send in 24 hours from one install is stored.
//  4. Network limit: a 21st send from one network is stored when the installs differ.
//  5. A parallel burst from one install slips past the limit.
//  6. 429 without Retry-After, or a message the app can't show.
//  7. The raw IP reaches D1.
//  8. A Problem sends no email, or an Idea sends one; HTML in a message reaches the email unescaped.
//  9. The digest miscounts, drops a message of the week or includes an older one.

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "useful-bot-feedback";
const out = process.argv[2] ?? "e2e-results.json";
const results = [];
let devLog = "";

function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function sql(command) {
  const raw = wrangler(["d1", "execute", DB, "--local", "--json", "--command", command]);
  return JSON.parse(raw)[0].results;
}
function clear() {
  sql("DELETE FROM feedback");
}
function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` :: ${JSON.stringify(detail)}`}`);
}
async function post(body, { type = "application/json", raw } = {}) {
  const res = await fetch(`${BASE}/v1/feedback`, {
    method: "POST",
    headers: { "content-type": type },
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, retryAfter: res.headers.get("retry-after") };
}
const valid = (over = {}) => ({
  kind: "idea",
  message: "The model picker could remember my last choice.",
  replyEmail: null,
  installId: randomUUID(),
  context: { appVersion: "0.3.0", build: "412", macosVersion: "15.6.1", chip: "Apple M1" },
  ...over,
});
const emailCount = () => (devLog.match(/send_email binding called/g) ?? []).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fresh local database with the real migration.
wrangler(["d1", "migrations", "apply", DB, "--local"]);
clear();

const dev = spawn(
  "npx",
  ["wrangler", "dev", "--port", String(PORT), "--test-scheduled", "--var", "IP_SALT:e2e-local-salt"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));
try {
  for (let i = 0; i < 60 && !/Ready on/.test(devLog); i++) await sleep(500);
  if (!/Ready on/.test(devLog)) throw new Error(`wrangler dev didn't start:\n${devLog}`);

  // 1. Request shape
  let r = await fetch(`${BASE}/v1/feedback`);
  check("GET is 405", r.status === 405, r.status);
  r = await fetch(`${BASE}/elsewhere`, { method: "POST" });
  check("unknown path is 404", r.status === 404, r.status);
  let p = await post(valid(), { type: "text/plain" });
  check("text/plain is 415", p.status === 415, p);
  p = await post(null, { raw: "{not json" });
  check("broken JSON is 400", p.status === 400 && p.json?.field === "body", p);
  p = await post(null, { raw: JSON.stringify(valid({ message: "x".repeat(40_000) })) });
  check("40 KB body is 413", p.status === 413, p);
  p = await post(null, { raw: "[1,2]" });
  check("JSON array is 400", p.status === 400 && p.json?.field === "body", p);

  // 2. Fields
  const bad = [
    ["kind unknown", { kind: "bug" }, "kind"],
    ["message whitespace only", { message: "  \n\t " }, "message"],
    ["message 4,001 chars", { message: "a".repeat(4001) }, "message"],
    ["message number", { message: 42 }, "message"],
    ["replyEmail malformed", { replyEmail: "not-an-email" }, "replyEmail"],
    ["replyEmail header injection", { replyEmail: "a@b.co\r\nBcc: x@evil.test" }, "replyEmail"],
    ["installId missing", { installId: undefined }, "installId"],
    ["installId not a UUID", { installId: "1234" }, "installId"],
    ["context not an object", { context: "0.3.0" }, "context"],
    ["context value too long", { context: { chip: "M".repeat(65) } }, "context.chip"],
    ["context value non-ASCII control", { context: { build: "4\n12" } }, "context.build"],
  ];
  for (const [name, over, field] of bad) {
    p = await post(valid(over));
    check(`${name} is 400 on ${field}`, p.status === 400 && p.json?.field === field, p);
  }
  const emoji = "🙂".repeat(4000);
  p = await post(valid({ message: emoji }));
  check("4,000 emoji is accepted", p.status === 201, p);
  const stored = sql(`SELECT length(message) AS n FROM feedback WHERE id = '${p.json?.id}'`);
  check("4,000 emoji stored whole", stored[0]?.n === 4000, stored);
  p = await post(valid({ replyEmail: "", context: null }));
  check("empty replyEmail and null context accepted", p.status === 201, p);
  const row = sql(`SELECT reply_email, app_version, chip FROM feedback WHERE id = '${p.json?.id}'`)[0];
  check("empty replyEmail and null context stored as NULL", row && row.reply_email === null && row.app_version === null && row.chip === null, row);

  // 7. Raw IP never stored
  const ips = sql("SELECT DISTINCT ip_hash FROM feedback");
  check(
    "ip_hash is a 64-char HMAC, not an IP",
    ips.length > 0 && ips.every((x) => /^[0-9a-f]{64}$/.test(x.ip_hash)),
    ips,
  );

  // 3 + 5 + 6. Install limit under a parallel burst
  clear();
  const install = randomUUID();
  const burst = await Promise.all(Array.from({ length: 10 }, () => post(valid({ installId: install }))));
  const accepted = burst.filter((x) => x.status === 201).length;
  const limited = burst.filter((x) => x.status === 429);
  check("10 parallel sends from one install store exactly 5", accepted === 5 && limited.length === 5, burst.map((x) => x.status));
  const count = sql(`SELECT count(*) AS n FROM feedback WHERE install_id = '${install}'`)[0].n;
  check("D1 holds exactly 5 rows for the install", count === 5, count);
  const l = limited[0];
  check(
    "429 carries Retry-After near 24 h, scope install and a plain message",
    l && Number(l.retryAfter) > 86_000 && Number(l.retryAfter) <= 86_400 && l.json?.scope === "install" &&
      l.json?.message === "You've reached today's feedback limit. Try again tomorrow.",
    l,
  );
  p = await post(valid());
  check("another install on the same network still gets through", p.status === 201, p);

  // Aged rows leave the window
  sql(`UPDATE feedback SET created_at = '${new Date(Date.now() - 25 * 3600e3).toISOString()}' WHERE install_id = '${install}'`);
  p = await post(valid({ installId: install }));
  check("sends older than 24 h stop counting", p.status === 201, p);

  // 4. Network limit
  clear();
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await post(valid())).status);
  const last = await post(valid());
  check(
    "20 sends from one network pass, the 21st is 429 scope network",
    statuses.slice(0, 20).every((s) => s === 201) && statuses[20] === 429 && last.json?.scope === "network",
    { statuses, last },
  );

  // 8. Email
  clear();
  let before = emailCount();
  await post(valid({ kind: "idea" }));
  await post(valid({ kind: "other" }));
  await sleep(1500);
  check("Idea and Other send no email", emailCount() === before, { before, after: emailCount() });
  before = emailCount();
  p = await post(
    valid({ kind: "problem", message: "Chat froze <script>alert(1)</script> & stayed blank.", replyEmail: "owner@example.com" }),
  );
  for (let i = 0; i < 20 && emailCount() === before; i++) await sleep(250);
  check("a Problem sends one email", p.status === 201 && emailCount() === before + 1, { p, before, after: emailCount() });
  const htmlFile = [...devLog.matchAll(/HTML: (\S+\.html)/g)].at(-1)?.[1];
  const html = htmlFile ? readFileSync(htmlFile, "utf8") : "";
  check(
    "the Problem email escapes HTML and names the reply address",
    html.includes("&lt;script&gt;") && !html.includes("<script>") && html.includes("owner@example.com"),
    { htmlFile, html: html.slice(0, 400) },
  );

  // 9. Digest
  clear();
  const at = (days) => new Date(Date.now() - days * 86400e3).toISOString();
  const seed = [
    ["idea", "digest idea", at(1)],
    ["problem", "digest problem", at(2)],
    ["other", "digest other", at(6.9)],
    ["idea", "too old for this week", at(8)],
  ];
  for (const [kind, message, created] of seed) {
    sql(
      `INSERT INTO feedback (id, created_at, kind, message, install_id, ip_hash) VALUES ('${randomUUID()}', '${created}', '${kind}', '${message}', '${randomUUID()}', 'seed')`,
    );
  }
  before = emailCount();
  r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent("0 7 * * MON")}`);
  for (let i = 0; i < 20 && emailCount() === before; i++) await sleep(250);
  const textFile = [...devLog.matchAll(/Text: (\S+\.txt)/g)].at(-1)?.[1];
  const text = textFile ? readFileSync(textFile, "utf8") : "";
  check(
    "digest counts the week by kind, lists each message and leaves out older ones",
    r.status === 200 && emailCount() === before + 1 &&
      text.includes("3 this week: 1 ideas, 1 problems, 1 other.") &&
      ["digest idea", "digest problem", "digest other"].every((m) => text.includes(m)) &&
      !text.includes("too old for this week"),
    { status: r.status, textFile, text: text.slice(0, 600) },
  );
} finally {
  dev.kill("SIGINT");
  const passed = results.filter((x) => x.pass).length;
  const summary = { ranAt: new Date().toISOString(), passed, failed: results.length - passed, results };
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\n${passed}/${results.length} passed. Results: ${out}`);
  process.exitCode = summary.failed === 0 ? 0 : 1;
}
