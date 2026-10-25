import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../agent/tools/index.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const WORD_CAP = 950;

// Failure cases first: each one must be caught on a bad prompt.

test("a prompt over the word cap fails", () => {
  const bad = Array.from({ length: WORD_CAP + 1 }, () => "word").join(" ");
  assert.equal(overWordCap(bad), true);
  assert.equal(overWordCap(bad.split(" ").slice(1).join(" ")), false);
});

test("a made-up single-word or camelCase tool name in backticks is reported", () => {
  const known = new Set(["bash"]);
  assert.deepEqual(unknownIdentifiers("Use `bash`, `mystery` and `runEverything`; `timeoutMs` is a parameter.", known), ["mystery", "runEverything"]);
});

test("a tool name with no tool file is reported", () => {
  const known = new Set(["bash", "read_file"]);
  assert.deepEqual(unknownToolNames("Use `read_file` then `read_fiel`.", known), ["read_fiel"]);
});

test("a removed tool is reported", () => {
  const known = new Set<string>(["read_file"]);
  assert.deepEqual(unknownToolNames("Spawn it with `task_cancel`.", known), ["task_cancel"]);
});

test("a made-up tool in a skill body is reported", () => {
  const known = new Set(["find_tools"]);
  assert.deepEqual(unknownToolNames("Call `find_tools`, then `connector_run_all`.", known), ["connector_run_all"]);
});

test("team, peer, handoff, sub-agent and reviewer talk is reported", () => {
  assert.deepEqual(multiBotWords("Another bot is a peer, not the owner."), ["another bot", "peer"]);
  assert.deepEqual(multiBotWords("Split the work into parallel sub-agents, or ask the Reviewer."), ["sub-agent", "reviewer"]);
  assert.deepEqual(multiBotWords("Hand it to a teammate with a handoff."), ["handoff", "teammate"]);
  assert.deepEqual(multiBotWords("Post to the group, or run the whole team."), ["team", "group"]);
  assert.deepEqual(multiBotWords("You are the owner's assistant. Read the file, then answer."), []);
});

test("status codes and mounted connection tools are not tool names", () => {
  const known = new Set<string>();
  assert.deepEqual(unknownToolNames("`connectors_not_set_up` and `excalidraw__create_view`.", known), []);
});

test("an unknown mounted prefix is reported", () => {
  assert.deepEqual(unknownToolNames("`mystery__do_it`", new Set<string>()), ["mystery__do_it"]);
});

// The real checks.

test("agent/instructions.md is at most 950 words", () => {
  const text = read("agent/instructions.md");
  assert.equal(overWordCap(text), false, `instructions.md is ${wordCount(text)} words, the cap is ${WORD_CAP}`);
});

test("every tool name in the instructions and skills is a real tool", () => {
  const known = knownTools();
  const files = ["agent/instructions.md", ...skillFiles()];
  assert.ok(files.length >= 3, "expected the instructions and both skills");
  for (const file of files) {
    assert.deepEqual(unknownToolNames(read(file), known), [], `${file} names a tool that does not exist`);
  }
});

test("no backticked identifier in the instructions, skills or tool descriptions is made up", () => {
  const known = knownTools();
  const texts: [string, string][] = ["agent/instructions.md", ...skillFiles()].map((file) => [file, read(file)]);
  for (const tool of allTools()) texts.push([`tool ${tool.name}`, tool.description]);
  for (const [file, text] of texts) {
    assert.deepEqual(unknownIdentifiers(text, known), [], `${file} backticks an identifier that is not a known tool, parameter or allowed term`);
    assert.deepEqual(unknownToolNames(text, known), [], `${file} names a tool that does not exist`);
  }
});

test("the known tools are the 16 declared ones, and nothing from eve is among them", () => {
  const known = knownTools();
  assert.equal(known.size, 16);
  assert.ok(known.has("find_tools"));
  for (const gone of ["connection_search", "ask_question", "task_cancel", "agent"]) assert.equal(known.has(gone), false, gone);
});

test("the instructions and skills have no team, peer, handoff, sub-agent or reviewer text", () => {
  for (const file of ["agent/instructions.md", ...skillFiles()]) {
    assert.deepEqual(multiBotWords(read(file)), [], `${file} talks about other bots, groups, sub-agents or a reviewer`);
  }
});

test("none of the removed multi-bot tools is named in the instructions or skills", () => {
  const removed = [
    "list_bots", "rail_action", "delete_bot", "propose_bot", "propose_group", "post_to_group", "send_to_bot", "update_bot_profile",
    "clear_history", "review", "list_models", "ask_question", "connector_catalog", "connector_search", "connector_execute",
    "propose_connector", "propose_connection", "connection_search", "memory_search", "memory_read", "memory_upsert", "memory_delete",
    "create_routine", "update_routine", "delete_routine", "list_routines", "run_routine",
  ];
  const dir = join(ROOT, "agent/tools");
  for (const name of removed) assert.equal(existsSync(join(dir, `${name}.ts`)), false, `${name}.ts is still there`);
  for (const file of ["agent/instructions.md", ...skillFiles()]) {
    const text = read(file);
    for (const name of removed) assert.equal(text.includes(`\`${name}\``), false, `${file} names \`${name}\``);
  }
});

// Helpers.

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Words the one-bot prompts must not use: other bots, groups, sub-agents, handoffs, a reviewer. */
const MULTI_BOT = [
  ["another bot", /\banother bot\b/i],
  ["sub-agent", /\bsub-?agents?\b/i],
  ["handoff", /\bhand-?offs?\b/i],
  ["reviewer", /\breviewers?\b/i],
  ["teammate", /\bteammates?\b/i],
  ["peer", /\bpeers?\b/i],
  ["team", /\bteam\b/i],
  ["group", /\bgroups?\b/i],
] as const;

function multiBotWords(text: string): string[] {
  return MULTI_BOT.filter(([, pattern]) => pattern.test(text)).map(([word]) => word);
}

function overWordCap(text: string): boolean {
  return wordCount(text) > WORD_CAP;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Backticked snake_case words that name a result status, not a tool. */
const STATUS_TOKENS = new Set(["connectors_not_set_up", "not_connected", "no_connectors"]);
/** Tools mounted from a connection are named `<connection>__<tool>`. */
const MOUNTED_PREFIXES = ["excalidraw__"];

function knownTools(): Set<string> {
  return new Set(allTools().map((tool) => tool.name));
}

function skillFiles(): string[] {
  const dir = join(ROOT, "agent/skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => `agent/skills/${name}/SKILL.md`);
}

/** Backticked snake_case tokens that are not a known tool, a status code or a mounted tool. */
function unknownToolNames(text: string, known: Set<string>): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([a-z][a-z0-9]*(?:_{1,2}[a-z0-9]+)+)`/g)) {
    const token = match[1]!;
    if (known.has(token) || STATUS_TOKENS.has(token)) continue;
    if (MOUNTED_PREFIXES.some((prefix) => token.startsWith(prefix))) continue;
    found.add(token);
  }
  return [...found];
}

/**
 * Backticked single words and camelCase identifiers are tool names, parameters,
 * enum values, command-line tools or file names. Anything else is a made-up name.
 */
const ALLOWED_IDENTIFIERS = new Set<string>([
  // parameters, enum values and result fields
  "timeoutMs", "timedOut", "exitCode", "status", "blocked", "active", "schedules", "model", "connectionId", "kind", "query",
  "list", "install", "todos", "all", "format", "text", "markdown", "html",
  // commands and tools on the owner's Mac
  "ls", "cat", "grep", "find", "git", "gh", "npm", "codex", "claude", "curl", "python", "node", "make", "brew", "textutil", "sips", "mdls", "pip", "rm", "sh",
  // modes, files and folders
  "main", "Library", "Documents", "secrets",
]);

function unknownIdentifiers(text: string, known: Set<string>): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([a-z][A-Za-z0-9]*)`/g)) {
    const token = match[1]!;
    if (known.has(token) || ALLOWED_IDENTIFIERS.has(token)) continue;
    found.add(token);
  }
  return [...found];
}
