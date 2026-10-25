#!/usr/bin/env node
/**
 * Write the four perf fixture chats of the dev stack's one bot (SPEC 14, Perf).
 *
 *   UB_STACK=dev UB_STATE_ROOT=~/.useful-bot-dev-app UB_ENGINE_PORT=4421 \
 *     node scripts/perf-fixtures.mjs
 *
 * The chats are synthetic Pi session files built with the same SessionManager
 * calls the engine uses, so no paid turn runs and the engine loads them like
 * any other chat. They are flagged `fixture: true` in `<stateRoot>/engine/chats.json`,
 * which keeps them out of the sidebar; the perf harness lists them with
 * `GET /api/chats?includeFixtures=1`. Content is seeded (the same every run);
 * entry ids and timestamps come from Pi, so `perf/run.sh lock` records the
 * file hashes after a write.
 *
 * Refuses unless UB_STACK=dev and UB_STATE_ROOT are set, and while the engine
 * listens on UB_ENGINE_PORT (quit the dev app first): the engine owns
 * chats.json and rewrites it whole.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { UB } from "../agent/engine/protocol.ts";
import { DEFAULT_BOT_ID } from "../shared/shell-store.ts";
import { enginePort, isDevStateFolder, LOOPBACK } from "../shared/stack.ts";

const BASE_TIME = Date.parse("2026-10-01T09:00:00.000Z");
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Titles are the harness's handle on each chat. `kind` picks the generator. */
export const FIXTURES = [
  { title: "Perf Long Replies", kind: "replies", turns: 3_749 },
  { title: "Perf Long Tools", kind: "tools", turns: 125 },
  { title: "Perf Short A", kind: "short", turns: 3, topics: ["a hash map", "a queue", "a stack"] },
  { title: "Perf Short B", kind: "short", turns: 3, topics: ["DNS", "TLS", "a CDN"] },
];

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hashOf = (text) => createHash("sha256").update(text).digest();

/** A stable UUID-shaped id from a title, so a rewrite replaces the same chat. */
function chatIdFor(title) {
  const h = hashOf(`perf-fixture:${title}`);
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const turnIdFor = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const WORDS = ["router", "engine", "session", "queue", "cache", "token", "stream", "buffer", "index", "socket", "worker", "schema",
  "parser", "kernel", "thread", "window", "signal", "bundle", "layout", "render", "commit", "branch", "record", "digest"];

function sentence(rand, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  const text = out.join(" ");
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

function paragraph(rand, sentences) {
  const out = [];
  for (let i = 0; i < sentences; i += 1) out.push(sentence(rand, 8 + Math.floor(rand() * 8)));
  return out.join(" ");
}

/** A markdown answer with a heading, prose, a table and a code block. */
function markdownReply(rand, n) {
  const rows = [];
  for (let i = 0; i < 4; i += 1) rows.push(`| ${WORDS[Math.floor(rand() * WORDS.length)]} | ${Math.floor(rand() * 900) + 100} | ${sentence(rand, 3)} |`);
  return [
    `## Answer ${n}`,
    "",
    paragraph(rand, 3),
    "",
    "| Part | Cost | Note |",
    "|---|---|---|",
    ...rows,
    "",
    paragraph(rand, 2),
    "",
    "```ts",
    `export function step${n}(input: number): number {`,
    `  // ${sentence(rand, 6)}`,
    `  return input * ${Math.floor(rand() * 90) + 2} + ${n % 97};`,
    "}",
    "```",
    "",
    paragraph(rand, 2),
  ].join("\n");
}

function longReply(rand, words) {
  const out = [];
  let count = 0;
  while (count < words) {
    const p = paragraph(rand, 4);
    out.push(p);
    count += p.split(" ").length;
  }
  return out.join("\n\n");
}

function toolOutput(rand, lines) {
  const out = [];
  for (let i = 0; i < lines; i += 1) out.push(`${WORDS[Math.floor(rand() * WORDS.length)]}-${Math.floor(rand() * 9000) + 1000}`);
  return out.join("\n");
}

const assistant = (content, stopReason, at) => ({
  role: "assistant", content, api: "openai-completions", provider: "useful-router", model: "m", usage: USAGE, stopReason, timestamp: at,
});

/** Append one owner turn: turn-start, the user message, whatever `body` adds, then turn-end. */
function appendTurn(sm, n, at, text, body) {
  const turnId = turnIdFor(n);
  sm.appendCustomEntry(UB.turnStart, { turnId, origin: "owner", clientId: `perf-${n}`, text, attachments: [] });
  sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: at });
  const last = body(at);
  sm.appendCustomEntry(UB.turnEnd, { turnId, outcome: "completed" });
  return { turnId, last };
}

function fillChat(sm, fixture, seedIndex) {
  const rand = seeded(1000 + seedIndex);
  let preview = "";
  let lastTurnId = turnIdFor(0);
  for (let n = 0; n < fixture.turns; n += 1) {
    const at = BASE_TIME + n * 60_000;
    const done = (text) => { preview = text; };
    let text;
    let body;
    if (fixture.kind === "replies") {
      const final = n === fixture.turns - 1;
      text = final ? "Write the long version, with every detail." : `Explain part ${n + 1} with a table and an example.`;
      body = () => {
        const reply = final ? longReply(rand, 1_500) : markdownReply(rand, n + 1);
        sm.appendMessage(assistant([{ type: "text", text: reply }], "stop", at + 1));
        done(reply);
      };
    } else if (fixture.kind === "tools") {
      text = `Run batch ${n + 1} of the checks.`;
      body = () => {
        for (let c = 0; c < 12; c += 1) {
          const id = `call-${n}-${c}`;
          sm.appendMessage(assistant([{ type: "toolCall", id, name: "echo", arguments: { text: `check ${n}-${c}` } }], "toolUse", at + 1 + c));
          sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: "echo", content: [{ type: "text", text: toolOutput(rand, 8 + Math.floor(rand() * 20)) }], isError: false, timestamp: at + 2 + c });
        }
        const reply = `Batch ${n + 1} done: 12 commands ran.`;
        sm.appendMessage(assistant([{ type: "text", text: reply }], "stop", at + 20));
        done(reply);
      };
    } else {
      text = `One sentence: what is ${fixture.topics[n]}?`;
      body = () => {
        const reply = sentence(rand, 14);
        sm.appendMessage(assistant([{ type: "text", text: reply }], "stop", at + 1));
        done(reply);
      };
    }
    lastTurnId = appendTurn(sm, n + 1, at, text, body).turnId;
  }
  return { preview, lastTurnId };
}

const clip = (text, max) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/**
 * Write the fixture chats into `<stateRoot>/engine/`: session files under
 * `sessions/<bot>/`, entries merged into `chats.json`. Earlier fixture entries
 * (and their session files) are replaced; other chats are not touched.
 * Returns one summary per fixture.
 */
export function writePerfFixtures({ stateRoot, botId = DEFAULT_BOT_ID }) {
  const engineDir = path.join(stateRoot, "engine");
  const indexPath = path.join(engineDir, "chats.json");
  mkdirSync(engineDir, { recursive: true });
  let existing = { schemaVersion: 1, chats: [] };
  if (existsSync(indexPath)) {
    existing = JSON.parse(readFileSync(indexPath, "utf8"));
    if (existing.schemaVersion !== 1 || !Array.isArray(existing.chats)) throw new Error(`${indexPath} is not a chat index (schemaVersion 1)`);
  }
  const kept = existing.chats.filter((chat) => chat.fixture !== true);
  const sessionDir = path.join(engineDir, "sessions", botId);
  mkdirSync(sessionDir, { recursive: true });
  for (const chat of existing.chats) {
    if (chat.fixture === true && chat.sessionFile) rmSync(path.resolve(engineDir, chat.sessionFile), { force: true });
  }

  const summaries = [];
  const fixtureChats = [];
  FIXTURES.forEach((fixture, i) => {
    const chatId = chatIdFor(fixture.title);
    const sm = SessionManager.create(engineDir, sessionDir, { id: chatId });
    const { preview, lastTurnId } = fillChat(sm, fixture, i);
    const file = sm.getSessionFile();
    if (!file || !existsSync(file)) throw new Error(`Pi did not write a session file for ${fixture.title}`);
    const entries = sm.getEntries().length;
    const at = new Date(BASE_TIME + fixture.turns * 60_000).toISOString();
    fixtureChats.push({
      chatId, botId, sessionFile: path.relative(engineDir, file), title: fixture.title, titleSetByOwner: true,
      preview: clip(preview, 120), routineId: null, fixture: true, createdAt: new Date(BASE_TIME).toISOString(), updatedAt: at,
      lastTurn: { turnId: lastTurnId, outcome: "completed", endedAt: at }, questionOpen: false,
    });
    summaries.push({ title: fixture.title, chatId, sessionFile: file, entries, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
  });

  const tmp = `${indexPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, chats: [...kept, ...fixtureChats] }), { mode: 0o600 });
  renameSync(tmp, indexPath);
  return summaries;
}

/** Is something accepting connections on the engine's port? */
function listening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: LOOPBACK, port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

/** Throws unless this run is on the dev stack, with a state root, and the engine is not running. */
export async function assertSafeToWrite(env = process.env) {
  if (env.UB_STACK !== "dev") throw new Error("refusing: UB_STACK must be dev (the fixtures belong to the dev stack only)");
  if (!env.UB_STATE_ROOT) throw new Error("refusing: UB_STATE_ROOT is not set");
  // The same folder rule the dev stack's own check uses: never the daily state folder.
  if (!isDevStateFolder(env.UB_STATE_ROOT)) {
    throw new Error(`refusing: UB_STATE_ROOT must be a dev state folder, got ${env.UB_STATE_ROOT}`);
  }
  const port = enginePort(env);
  if (await listening(port)) throw new Error(`refusing: the engine is listening on ${LOOPBACK}:${port}; quit Useful Bot Dev first`);
}

async function main() {
  await assertSafeToWrite();
  const summaries = writePerfFixtures({ stateRoot: process.env.UB_STATE_ROOT });
  for (const s of summaries) console.log(`${s.title}: ${s.entries} entries, ${s.chatId}`);
  console.log("now run: perf/run.sh lock");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
