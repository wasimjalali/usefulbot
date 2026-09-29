import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverFirstBrief } from "../web/lib/agent-exec.ts";
import { listThreadEvents } from "../shared/agent-store.ts";
import { listHandoffs } from "../shared/handoffs.ts";
import { applyShellAction, seedStore, type ShellStore } from "../shared/shell-store.ts";

/** A roster with a proposer and the bot a createBot card just created. */
function roster(): { store: ShellStore; ceoId: string; artistId: string; roomId: string } {
  let store = seedStore();
  const ceo = applyShellAction(store, { type: "createBot", name: "CEO" });
  store = ceo.store;
  const artist = applyShellAction(store, { type: "createBot", name: "Storyboard Artist" });
  store = artist.store;
  const room = applyShellAction(store, {
    type: "createGroup",
    name: "Room",
    memberIds: [ceo.createdId!, artist.createdId!],
  });
  store = room.store;
  return { store, ceoId: ceo.createdId!, artistId: artist.createdId!, roomId: room.createdId! };
}

function inTempStores<T>(run: (paths: { storePath: string; handoffDir: string }) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ub-brief-"));
  const storePath = join(dir, "agents.json");
  const handoffDir = join(dir, "handoffs");
  const previousStore = process.env.UB_AGENT_STORE_PATH;
  const previousDir = process.env.UB_HANDOFF_DIR;
  process.env.UB_AGENT_STORE_PATH = storePath;
  process.env.UB_HANDOFF_DIR = handoffDir;
  try {
    return run({ storePath, handoffDir });
  } finally {
    if (previousStore === undefined) delete process.env.UB_AGENT_STORE_PATH;
    else process.env.UB_AGENT_STORE_PATH = previousStore;
    if (previousDir === undefined) delete process.env.UB_HANDOFF_DIR;
    else process.env.UB_HANDOFF_DIR = previousDir;
  }
}

test("approving a teammate card hands the new bot its first brief", () => {
  const { store, ceoId, artistId } = roster();
  inTempStores(({ storePath, handoffDir }) => {
    const queued = deliverFirstBrief({
      brief: "  First assignment: storyboard the five minute cut.  ",
      createdBotId: artistId,
      sourceBotId: ceoId,
      bots: store.bots,
    });
    assert.equal(queued, 1);
    assert.equal(listHandoffs(handoffDir).length, 1);

    // The work lands in the new bot's own chat, not in the proposer's.
    const artist = listThreadEvents(artistId, storePath);
    assert.equal(artist.length, 1);
    assert.equal(artist[0].kind, "post");
    assert.equal(artist[0].authorName, "CEO");
    assert.equal(artist[0].text, "First assignment: storyboard the five minute cut.");
    const ceo = listThreadEvents(ceoId, storePath);
    assert.equal(ceo.length, 1);
    assert.equal(ceo[0].kind, "handoff");
    assert.equal(ceo[0].targetBotIds[0], artistId);
  });
});

test("a card with no brief, or a creation that did not happen, queues nothing", () => {
  const { store, ceoId, artistId, roomId } = roster();
  const bots = store.bots;
  inTempStores(({ handoffDir }) => {
    assert.equal(deliverFirstBrief({ brief: "   ", createdBotId: artistId, sourceBotId: ceoId, bots }), 0);
    assert.equal(deliverFirstBrief({ brief: "do this", createdBotId: undefined, sourceBotId: ceoId, bots }), 0);
    // A bot that is already gone, and a group, are never briefed.
    assert.equal(deliverFirstBrief({ brief: "do this", createdBotId: "bot-ghost", sourceBotId: ceoId, bots }), 0);
    assert.equal(deliverFirstBrief({
      brief: "do this",
      createdBotId: roomId,
      sourceBotId: ceoId,
      bots,
    }), 0);
    assert.equal(listHandoffs(handoffDir).length, 0);
  });
});
