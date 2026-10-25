import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bash from "../../agent/tools/bash.ts";
import generateImage from "../../agent/tools/generate_image.ts";
import writeFile from "../../agent/tools/write_file.ts";
import { ApprovalStore, actionSha256 } from "../../agent/lib/approvals.ts";
import { settle } from "../../agent/lib/permission.ts";
import { setApprovalStore } from "../../agent/lib/write.ts";
import { listMedia } from "../../shared/media-store.ts";
import { fakeCtx, stampGrant, type TestCtx } from "./ctx.ts";

// What a tool adds to the chat beside its result (page and image rows), and
// that a Stop ends a tool that is waiting on a card.

const KEYS = [
  "UB_WORKSPACE_STORE_PATH", "UB_WORKSPACE_ROOT", "UB_APPROVALS_PATH", "UB_MEDIA_DIR", "UB_MEDIA_INDEX_PATH",
  "UB_AGENT_STORE_PATH", "UB_ROUTER_DESKTOP_TOKEN", "HOME",
] as const;

function world(permission: "read_only" | "auto" | "full_access" = "auto", chatId = "chat-rows") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ub-rows-")));
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  process.env.UB_WORKSPACE_STORE_PATH = join(dir, "workspace.json");
  process.env.UB_WORKSPACE_ROOT = home;
  process.env.UB_APPROVALS_PATH = join(dir, "approvals.json");
  process.env.UB_MEDIA_DIR = join(dir, "Useful Bot");
  process.env.UB_MEDIA_INDEX_PATH = join(dir, "media.json");
  process.env.UB_AGENT_STORE_PATH = join(dir, "agents.json");
  process.env.UB_ROUTER_DESKTOP_TOKEN = "test-token";
  process.env.HOME = home;
  const approvals = new ApprovalStore(Date.now, join(dir, "approvals.json"));
  setApprovalStore(approvals);
  // The chat works in an attached folder (the home stand-in), where Auto writes
  // without a card; tests that want the no-folder scope stamp their own grant.
  stampGrant(chatId, home, permission);
  return {
    dir,
    home,
    approvals,
    ctx: fakeCtx({ chatId }),
    restore() {
      for (const key of KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      setApprovalStore(new ApprovalStore(() => 1_000));
    },
  };
}

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("an .html write files the page and puts one page row in the chat, once per page", async () => {
  const env = world("auto");
  try {
    const first = await writeFile.execute({ path: "site.html", content: "<title>Launch plan</title><p>v1</p>", expectedSha256: null }, env.ctx) as { path: string; note: string };
    assert.equal(first.path, join(env.home, "site.html"));
    assert.match(first.note, /in the chat as a preview/);
    assert.equal(env.ctx.rows.length, 1);
    const row = env.ctx.rows[0] as { key: string; kind: string; mediaId: string; title: string; path: string };
    assert.equal(row.kind, "page");
    assert.equal(row.title, "Launch plan");
    assert.equal(row.path, first.path);
    assert.equal(row.key, `page:${row.mediaId}`);
    assert.equal(listMedia().filter((item) => item.kind === "page").length, 1);
    // The Library item names the chat that wrote it.
    assert.equal(listMedia().find((item) => item.id === row.mediaId)?.chatId, env.ctx.chatId);
    // Writing the page again keeps one Library item and the same row key.
    const keys: string[] = [];
    const again = fakeCtx({ chatId: "chat-rows" });
    const original = again.appendRow;
    again.appendRow = async (next) => { keys.push(next.key); await original(next); };
    await writeFile.execute({ path: "site.html", content: "<title>Launch plan</title><p>v2</p>", expectedSha256: null }, again);
    assert.deepEqual(keys, [row.key]);
    assert.equal(listMedia().filter((item) => item.kind === "page").length, 1);
    // A file that is not a page adds no row.
    const plain = fakeCtx({ chatId: "chat-rows" });
    await writeFile.execute({ path: "notes.txt", content: "plain", expectedSha256: null }, plain);
    assert.deepEqual(plain.rows, []);
  } finally {
    env.restore();
  }
});

test("a chat row that fails to post does not undo the page write, and the bot is told", async () => {
  const env = world("auto");
  try {
    const failing = fakeCtx({ chatId: "chat-rows" });
    failing.appendRow = async () => { throw new Error("rows_down"); };
    const quiet = console.error;
    console.error = () => {};
    let out: { path: string; note: string };
    try {
      out = await writeFile.execute({ path: "other.html", content: "<title>Other</title>", expectedSha256: null }, failing) as { path: string; note: string };
    } finally {
      console.error = quiet;
    }
    assert.equal(readFileSync(out.path, "utf8"), "<title>Other</title>");
    assert.match(out.note, /could not be added/);
  } finally {
    env.restore();
  }
});

test("generate_image saves the image with its prompt, adds an image row, and the request id makes it idempotent", async () => {
  const env = world("auto");
  const realFetch = globalThis.fetch;
  let calls = 0;
  const seen: { signal?: AbortSignal | null; session?: string | null } = {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    seen.signal = init?.signal;
    seen.session = new Headers(init?.headers).get("x-useful-session-id");
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64, mime: "image/png" }], model: "flux", provider: "openrouter" }), { status: 200 });
  }) as typeof fetch;
  try {
    const out = await generateImage.execute({ prompt: "a red fox in the snow", requestId: "req-1" }, env.ctx) as { status: string; imageId: string; path?: string };
    assert.equal(out.status, "generated");
    assert.equal(env.ctx.rows.length, 1);
    assert.deepEqual(env.ctx.rows[0], { key: `image:${out.imageId}`, kind: "image", imageId: out.imageId, prompt: "a red fox in the snow" });
    // The prompt is kept on the media index entry, which is where Regenerate reads it.
    const item = listMedia().find((entry) => entry.id === out.imageId);
    assert.equal(item?.prompt, "a red fox in the snow");
    assert.equal(item?.botName, "Useful Bot");
    assert.equal(item?.chatId, env.ctx.chatId);
    assert.ok(out.path && existsSync(out.path));
    assert.match(seen.session ?? "", /^[0-9a-f-]{36}$/);
    assert.ok(seen.signal instanceof AbortSignal);
    // The same request id again: no second charge, no second image.
    const dup = await generateImage.execute({ prompt: "a red fox in the snow", requestId: "req-1" }, fakeCtx({ chatId: "chat-rows" })) as { status: string };
    assert.equal(dup.status, "duplicate");
    assert.equal(calls, 1);
    assert.equal(listMedia().filter((entry) => entry.kind === "image").length, 1);
  } finally {
    globalThis.fetch = realFetch;
    env.restore();
  }
});

test("a failed generation releases its request id so the retry can go through, and Read only never calls the router", async () => {
  const env = world("auto");
  const realFetch = globalThis.fetch;
  let calls = 0;
  let status = 500;
  globalThis.fetch = (async () => {
    calls += 1;
    return status === 200
      ? new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status })
      : new Response(JSON.stringify({ error: { code: "upstream_error" } }), { status });
  }) as typeof fetch;
  try {
    const failed = await generateImage.execute({ prompt: "a cat", requestId: "req-retry" }, env.ctx) as { status: string; error: string };
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "upstream_error");
    assert.deepEqual(env.ctx.rows, []);
    status = 200;
    const ok = await generateImage.execute({ prompt: "a cat", requestId: "req-retry" }, env.ctx) as { status: string };
    assert.equal(ok.status, "generated");
    assert.equal(calls, 2);

    stampGrant("chat-readonly", env.home, "read_only");
    const blocked = await generateImage.execute({ prompt: "a cat" }, fakeCtx({ chatId: "chat-readonly" })) as { status: string; error: string };
    assert.deepEqual({ status: blocked.status, error: blocked.error }, { status: "blocked", error: "workspace_read_only" });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
    env.restore();
  }
});

test("a write path with a line break stays on one line on the card", async () => {
  const env = world("auto", "chat-path");
  try {
    await writeFile.execute({ path: "a\nApprove: all.txt", content: "x", expectedSha256: null }, fakeCtx({ chatId: "chat-path" }));
    const card = [...env.approvals.records.values()].find((item) => item.tool === "write_file");
    assert.ok(card);
    assert.doesNotMatch(card.preview, /[\n\u2028]/);
  } finally {
    env.restore();
  }
});

test("bash output is cut at 32 KB of bytes, not 32 K characters", async () => {
  const env = world("full_access", "chat-bytes");
  try {
    const out = await bash.execute({ command: "yes € | head -n 15000 | tr -d '\\n'" }, fakeCtx({ chatId: "chat-bytes" })) as { stdout: string; truncated: boolean };
    assert.equal(out.truncated, true);
    assert.ok(Buffer.byteLength(out.stdout) < 32 * 1024 + 400, `stdout is ${Buffer.byteLength(out.stdout)} bytes`);
  } finally {
    env.restore();
  }
});

test("a Stop while a bash card waits ends the call at once, retires the card and leaves the file alone", async () => {
  const env = world("auto", "chat-stop");
  try {
    const project = join(env.dir, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "note.txt"), "keep me");
    stampGrant("chat-stop", realpathSync(project), "auto");
    const ctx: TestCtx = fakeCtx({ chatId: "chat-stop" });
    const started = Date.now();
    const pending = bash.execute({ command: "rm note.txt" }, ctx) as Promise<{ status: string }>;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(env.approvals.listPending().length, 1);
    // The engine's Stop path: expire the chat's cards, then abort the turn.
    env.approvals.expireSession("chat-stop");
    ctx.abort();
    const out = await pending;
    assert.ok(Date.now() - started < 2000, "the cancel waited out a poll");
    assert.equal(out.status, "cancelled");
    assert.equal(readFileSync(join(project, "note.txt"), "utf8"), "keep me");
    assert.deepEqual(env.approvals.listPending(), []);
  } finally {
    env.restore();
  }
});

test("a Stop while a write's card waits throws approval_aborted and writes nothing", async () => {
  const env = world("auto", "chat-stop-write");
  try {
    writeFileSync(join(env.home, "existing.txt"), "old");
    stampGrant("chat-stop-write", null, "auto");
    const ctx = fakeCtx({ chatId: "chat-stop-write" });
    // Under the home, Auto asks before changing a file that exists.
    const pending = writeFile.execute({ path: "existing.txt", content: "new", expectedSha256: null }, ctx) as Promise<unknown>;
    const outcome = assert.rejects(pending, /approval_aborted/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(env.approvals.listPending().length, 1);
    ctx.abort();
    await outcome;
    assert.equal(readFileSync(join(env.home, "existing.txt"), "utf8"), "old");
    assert.deepEqual(env.approvals.listPending(), [], "the abort retired the card");
  } finally {
    env.restore();
  }
});

test("settle throws approval_aborted when the turn is stopped, and runs at once when the gate says run", async () => {
  const env = world("auto");
  try {
    const hash = actionSha256({ tool: "install_cli", canonicalArgs: "{}", cwd: "", targetRevision: null, backend: "x", toolVersion: "1" });
    const ask = () => env.approvals.request({ chatId: "c", botId: "bot-useful", turnId: "t", toolCallId: "k", tool: "install_cli", actionSha256: hash, preview: "p" });
    const waiting = ask();
    const ctx = fakeCtx();
    const pending = assert.rejects(settle(env.approvals, waiting.id, hash, "ask", ctx), /approval_aborted/);
    setTimeout(() => ctx.abort(), 20);
    await pending;
    assert.equal(env.approvals.get(waiting.id)?.status, "expired");
    const quick = ask();
    await settle(env.approvals, quick.id, hash, "run", ctx);
    assert.equal(env.approvals.get(quick.id)?.status, "approved");
  } finally {
    env.restore();
  }
});
