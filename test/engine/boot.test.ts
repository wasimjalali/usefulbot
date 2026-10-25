import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ApprovalStore } from "../../agent/lib/approvals.ts";
import { readSessionGrant } from "../../shared/workspace-store.ts";
import { makeWorld, waitForRequests, type World } from "./helpers.ts";

/** What the engine does at boot (SPEC 5.1): stale cards, cut-off turns, waiting messages, the trash. */

test("cards left pending by the last process are expired, so there are no ghost cards", async () => {
  const world = await makeWorld();
  const restartRoot = `${world.root}-restart`;
  let second: World | null = null;
  try {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "tools", calls: [{ name: "gated", args: {} }] });
    world.send(chatId, "do the gated thing");
    const deadline = Date.now() + 5_000;
    while (world.state.approvals.listPending().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(world.state.approvals.listPending().length, 1);
    cpSync(world.root, restartRoot, { recursive: true });
    world.engine.cancel(chatId);
    await world.idle(chatId);

    const before = new ApprovalStore(Date.now, join(restartRoot, "approvals.json"));
    assert.equal(before.listPending().length, 1, "the copy still has the card");
    second = await makeWorld({ root: restartRoot, router: world.router });
    assert.equal(new ApprovalStore(Date.now, join(restartRoot, "approvals.json")).listPending().length, 0, "boot expired it");
    assert.equal(second.engine.status().chats.find((chat) => chat.chatId === chatId)?.waitingOnOwner, null);
  } finally {
    await second?.close();
    await world.close();
    rmSync(restartRoot, { recursive: true, force: true });
  }
});

test("trash older than thirty days is purged at boot, newer trash stays", async () => {
  const world = await makeWorld();
  const restartRoot = `${world.root}-restart`;
  let second: World | null = null;
  try {
    cpSync(world.root, restartRoot, { recursive: true });
    const trash = join(restartRoot, "engine", "trash");
    mkdirSync(trash, { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString().replace(/[:.]/g, "-");
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(trash, `${old}__old.jsonl`), "{}\n");
    writeFileSync(join(trash, `${recent}__recent.jsonl`), "{}\n");
    second = await makeWorld({ root: restartRoot, router: world.router });
    assert.equal(existsSync(join(trash, `${old}__old.jsonl`)), false);
    assert.equal(existsSync(join(trash, `${recent}__recent.jsonl`)), true);
  } finally {
    await second?.close();
    await world.close();
    rmSync(restartRoot, { recursive: true, force: true });
  }
});

test("a message that was waiting when the engine died comes back as an unsent row, and the cut-off turn as interrupted", async () => {
  const world = await makeWorld();
  const restartRoot = `${world.root}-restart`;
  let second: World | null = null;
  try {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "stall", text: "working" });
    world.send(chatId, "first");
    const waiting = crypto.randomUUID();
    world.send(chatId, "second, waiting", { clientId: waiting });
    await waitForRequests(world, 1);
    assert.ok(readSessionGrant(chatId), "the running turn holds a grant");
    const ledger = JSON.parse(readFileSync(join(world.root, "engine", "running.json"), "utf8")) as { turns: unknown[]; queued: { clientId: string }[] };
    assert.equal(ledger.turns.length, 1);
    assert.deepEqual(ledger.queued.map((item) => item.clientId), [waiting]);
    cpSync(world.root, restartRoot, { recursive: true });
    world.engine.cancel(chatId);
    world.router.release();
    await world.idle(chatId);

    second = await makeWorld({ root: restartRoot, router: world.router });
    const rows = second.engine.rows(chatId, {}).rows;
    assert.deepEqual(rows.map((row) => row.kind), ["user", "failure", "unsent"]);
    const unsent = rows[2] as { clientId: string; text: string; reason: string };
    assert.deepEqual([unsent.clientId, unsent.text, unsent.reason], [waiting, "second, waiting", "interrupted"]);
    assert.equal((rows[1] as { code: string }).code, "interrupted");
    assert.equal(readSessionGrant(chatId), null, "the dead turn's capability is revoked");
    const after = JSON.parse(readFileSync(join(restartRoot, "engine", "running.json"), "utf8")) as { turns: unknown[]; queued: unknown[] };
    assert.deepEqual([after.turns.length, after.queued.length], [0, 0], "boot cleared what it dealt with");
    // The unsent message can be sent again, and the chat goes on.
    second.router.enqueue({ kind: "text", text: "Done." });
    second.send(chatId, "second, waiting", { clientId: waiting });
    await second.idle(chatId);
    assert.equal((second.engine.rows(chatId, {}).rows.at(-1) as { text: string }).text, "Done.");
  } finally {
    await second?.close();
    await world.close();
    rmSync(restartRoot, { recursive: true, force: true });
  }
});

test("one chat that cannot be closed does not stop the others", async () => {
  const world = await makeWorld();
  const restartRoot = `${world.root}-restart`;
  let second: World | null = null;
  try {
    const bad = world.newChat();
    const good = world.newChat();
    world.router.enqueue({ kind: "stall", text: "a" }, { kind: "stall", text: "b" });
    world.send(bad, "one");
    world.send(good, "two");
    await waitForRequests(world, 2);
    cpSync(world.root, restartRoot, { recursive: true });
    world.engine.cancel(bad);
    world.engine.cancel(good);
    world.router.release();
    await world.idle(bad);
    await world.idle(good);
    const badFile = world.engine.host.index.require(bad).sessionFile as string;
    const relative = badFile.slice(world.root.length);
    writeFileSync(join(restartRoot, relative), "this is not a session file\n");

    second = await makeWorld({ root: restartRoot, router: world.router });
    assert.equal((second.engine.rows(good, {}).rows.at(-1) as { code?: string }).code, "interrupted");
    assert.equal((second.engine.rows(bad, {}).rows[0] as { code?: string }).code, "unreadable");
    second.router.enqueue({ kind: "text", text: "fine" });
    second.send(good, "more");
    await second.idle(good);
  } finally {
    await second?.close();
    await world.close();
    rmSync(restartRoot, { recursive: true, force: true });
  }
});
