import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyShellAction,
  DEFAULT_BOT_ID,
  GENERALIST_SEED_V2,
  GENERALIST_SEEDS,
  parseShell,
  seedStore,
  type ShellStore,
} from "../shared/shell-store.ts";
import { readShell, updateShell } from "../shared/shell-io.ts";

/** A store as an older build wrote it: the Generalist with the given name and description. */
function oldStore(fields: { name?: string; description?: string; avatarCustom?: boolean }): ShellStore {
  const store = seedStore();
  const [bot] = store.bots;
  return {
    ...store,
    bots: [{
      ...bot,
      name: fields.name ?? "Useful Bot",
      description: fields.description ?? "",
      avatarCustom: fields.avatarCustom ?? false,
    }],
  };
}

function reread(store: ShellStore): ShellStore {
  return parseShell(JSON.parse(JSON.stringify(store)));
}

function tempShell(store: ShellStore): string {
  const dir = mkdtempSync(join(tmpdir(), "ub-seed-"));
  const path = join(dir, "shell.json");
  writeFileSync(path, JSON.stringify(store), "utf8");
  return path;
}

test("a fresh store seeds the current Generalist text", () => {
  const [bot] = seedStore().bots;
  assert.equal(bot.description, GENERALIST_SEED_V2);
  assert.equal(bot.name, "Generalist");
});

for (const [index, seed] of GENERALIST_SEEDS.entries()) {
  test(`seed ${index + 1} of the shipped list becomes the current text and the new name`, () => {
    const [bot] = reread(oldStore({ description: seed })).bots;
    assert.equal(bot.description, GENERALIST_SEED_V2);
    assert.equal(bot.name, "Generalist");
  });
}

test("a seed with extra spaces, tabs and line breaks still matches", () => {
  const spaced = ` ${GENERALIST_SEEDS[2].replace(/ /g, "  ")}\n`;
  const broken = GENERALIST_SEEDS[1].replace(". ", ".\n\t");
  for (const description of [spaced, broken]) {
    const [bot] = reread(oldStore({ description })).bots;
    assert.equal(bot.description, GENERALIST_SEED_V2);
  }
});

test("an edited seed is the owner's text and stays", () => {
  for (const description of [
    `${GENERALIST_SEEDS[2]} Always answer in French.`,
    GENERALIST_SEEDS[2].replace("starter", "main"),
    "",
    "Mine.",
  ]) {
    const [bot] = reread(oldStore({ description })).bots;
    assert.equal(bot.description, description);
    assert.equal(bot.name, "Useful Bot");
  }
});

test("only the Generalist is overlaid, never another bot with a seed text", () => {
  let store = seedStore();
  store = applyShellAction(store, { type: "createBot", name: "Copycat", description: GENERALIST_SEEDS[0] }).store;
  const loaded = reread(store);
  assert.equal(loaded.bots.find((bot) => bot.name === "Copycat")?.description, GENERALIST_SEEDS[0]);
});

test("a store with no Generalist loads without an overlay or a throw", () => {
  let store = seedStore();
  store = applyShellAction(store, { type: "createBot", name: "Other", description: GENERALIST_SEEDS[0] }).store;
  store = applyShellAction(store, { type: "deleteBot", botId: DEFAULT_BOT_ID }).store;
  assert.equal(store.bots.some((bot) => bot.id === DEFAULT_BOT_ID), false);
  const loaded = reread(store);
  assert.equal(loaded.bots[0].description, GENERALIST_SEEDS[0]);
  assert.equal(loaded.bots[0].name, "Other");
});

test("the rename needs the name Useful Bot, a seed and an untouched avatar", () => {
  const seed = GENERALIST_SEEDS[0];
  const custom = reread(oldStore({ description: seed, avatarCustom: true })).bots[0];
  assert.equal(custom.name, "Useful Bot");
  assert.equal(custom.description, GENERALIST_SEED_V2);
  const renamed = reread(oldStore({ name: "Jarvis", description: seed })).bots[0];
  assert.equal(renamed.name, "Jarvis");
  assert.equal(renamed.description, GENERALIST_SEED_V2);
});

test("reading the shell never writes it", () => {
  const path = tempShell(oldStore({ description: GENERALIST_SEEDS[1] }));
  const before = readFileSync(path, "utf8");
  const loaded = readShell(path);
  assert.equal(loaded.bots[0].description, GENERALIST_SEED_V2);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(`${path}.reseeded`), false);
});

test("the overlay persists on the next normal write", () => {
  const path = tempShell(oldStore({ description: GENERALIST_SEEDS[1] }));
  updateShell((shell) => applyShellAction(shell, { type: "toggleSection", sectionId: "unassigned" }).store, path);
  const file = JSON.parse(readFileSync(path, "utf8")) as ShellStore;
  assert.equal(file.bots[0].description, GENERALIST_SEED_V2);
  assert.equal(file.bots[0].name, "Generalist");
});

test("two processes reading the same old file agree and leave it untouched", () => {
  const path = tempShell(oldStore({ description: GENERALIST_SEEDS[2] }));
  const before = readFileSync(path, "utf8");
  const script = `
    import { readShell } from ${JSON.stringify(new URL("../shared/shell-io.ts", import.meta.url).href)};
    const bot = readShell(${JSON.stringify(path)}).bots[0];
    process.stdout.write(JSON.stringify([bot.name, bot.description]));
  `;
  const run = () => execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  const [first, second] = [run(), run()];
  assert.equal(first, second);
  assert.deepEqual(JSON.parse(first), ["Generalist", GENERALIST_SEED_V2]);
  assert.equal(readFileSync(path, "utf8"), before);
});
