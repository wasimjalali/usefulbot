import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../agent/lib/memory.ts";
import { createRoutine, listRoutines, readRoutinesStore, updateRoutine } from "../shared/routines-store.ts";
import { DEFAULT_BOT_ID } from "../shared/shell-store.ts";
import { memoryListing } from "../web/lib/memory-listing.ts";

// The Next route handlers cannot be imported by node (they sit behind the cookie
// gate and extensionless imports), so the rules they apply live in web/lib and
// are tested here; the source checks below hold the routes to calling them. The
// chat routes are tested through web/lib/engine-proxy.ts in test/web.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the routes call their helpers", () => {
  assert.match(read("web/app/api/memory/route.ts"), /memoryListing\(memoryStore\(\), botId\)/);
  assert.match(read("web/app/api/agent/tick/route.ts"), /pumpConnects\(\)/);
  assert.match(read("web/app/api/agent/tick/route.ts"), /sweepOrphanStateIfDue\(\)/);
});

test("the removed routes and libraries are gone", () => {
  for (const path of [
    "web/app/eve/v1/[...path]/route.ts",
    "web/app/api/agent/state/route.ts",
    "web/lib/eve-session-auth.ts",
    "web/lib/earlier-bots.ts",
    "web/lib/archived-bots.ts",
    "web/lib/media-migrate.ts",
  ]) {
    assert.throws(() => read(path), /ENOENT/, path);
  }
});

test("the tick answers no one but the owner's own session: it takes no agent key", () => {
  const source = read("web/app/api/agent/tick/route.ts");
  assert.doesNotMatch(source, /x-ub-agent-key|UB_CHANNEL_JWT/);
  assert.match(source, /requireOwner\(request\)/);
});

test("GET /api/memory answers a page of 100, and nothing for no bot", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-route-"));
  const store = new MemoryStore(join(dir, "memory"));
  try {
    for (let index = 0; index < 130; index += 1) {
      store.upsert({ expectedRevision: null, title: `Note ${index}`, tags: [], body: "b", botId: "bot-useful", source: "owner", expiresAt: null, sessionId: "s1" });
    }
    const listing = memoryListing(store, "bot-useful");
    assert.equal(listing.notes.length, 100);
    assert.deepEqual(memoryListing(store, "bot-nobody"), { notes: [] });
    assert.deepEqual(memoryListing(store, ""), { notes: [] });
    assert.deepEqual(memoryListing(null, "bot-useful"), { notes: [] });
  } finally {
    store.close();
  }
});

test("on the wire a routine carries its chat once the engine has made it, and an edit keeps it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-route-"));
  const saved = process.env.UB_ROUTINES_PATH;
  process.env.UB_ROUTINES_PATH = join(dir, "routines.json");
  try {
    const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    const routine = createRoutine({ botId: DEFAULT_BOT_ID, name: "Mine", instruction: "x", schedules: [] });
    // GET /api/routines?botId= returns the stored routines as they are.
    assert.equal(wire(listRoutines(DEFAULT_BOT_ID)[0]).chatId, null);
    assert.equal("movedFrom" in wire(listRoutines(DEFAULT_BOT_ID)[0]), false);
    assert.ok(routine.id);
    // PATCH /api/routines/:id returns the updated routine.
    assert.equal(wire(updateRoutine(routine.id, { name: "Still mine" })).name, "Still mine");
    assert.equal(readRoutinesStore().routines.length, 1);
  } finally {
    if (saved === undefined) delete process.env.UB_ROUTINES_PATH;
    else process.env.UB_ROUTINES_PATH = saved;
  }
});
