import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

test("a disabled tool is reported", () => {
  const known = new Set<string>(["read_file"]);
  assert.deepEqual(unknownToolNames("Spawn it with `task_cancel`.", known), ["task_cancel"]);
});

test("a made-up tool in a skill body is reported", () => {
  const known = new Set(["connector_search"]);
  assert.deepEqual(unknownToolNames("Call `connector_search`, then `connector_run_all`.", known), ["connector_run_all"]);
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

test("every tool name in the instructions and skills is a real, enabled tool", () => {
  const known = knownTools();
  const files = ["agent/instructions.md", ...skillFiles()];
  assert.ok(files.length >= 3, "expected the instructions and both skills");
  for (const file of files) {
    assert.deepEqual(unknownToolNames(read(file), known), [], `${file} names a tool that does not exist or is disabled`);
  }
});

test("no backticked identifier in the instructions, skills or tool descriptions is made up", async () => {
  const known = knownTools();
  const dir = join(ROOT, "agent/tools");
  const texts: [string, string][] = ["agent/instructions.md", ...skillFiles()].map((file) => [file, read(file)]);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const mod = (await import(join(dir, file))) as { default?: { description?: string } };
    texts.push([`agent/tools/${file}`, mod.default?.description ?? ""]);
  }
  for (const [file, text] of texts) {
    assert.deepEqual(unknownIdentifiers(text, known), [], `${file} backticks an identifier that is not a known tool, parameter or allowed term`);
    assert.deepEqual(unknownToolNames(text, known), [], `${file} names a tool that does not exist or is disabled`);
  }
});

test("known tools include find_tools and eve's sub-agent tools", () => {
  const known = knownTools();
  assert.ok(known.has("find_tools"));
  assert.ok(known.has("connection_search"));
  assert.ok(known.has("task_cancel"));
  assert.ok(known.has("agent"));
});

// Helpers.

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function overWordCap(text: string): boolean {
  return wordCount(text) > WORD_CAP;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Eve's default tools this agent keeps. */
const EVE_BUILT_INS = ["bash", "read_file", "write_file", "web_fetch", "web_search", "todo", "ask_question", "load_skill", "connection_search", "agent", "task_cancel"];
/** Backticked snake_case words that name a result status, not a tool. */
const STATUS_TOKENS = new Set(["connectors_not_set_up", "not_connected", "no_connectors"]);
/** Tools mounted from a connection are named `<connection>__<tool>`. */
const MOUNTED_PREFIXES = ["excalidraw__"];

function knownTools(): Set<string> {
  const dir = join(ROOT, "agent/tools");
  const names = new Set<string>(EVE_BUILT_INS);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const name = file.slice(0, -3);
    if (readFileSync(join(dir, file), "utf8").includes("disableTool(")) names.delete(name);
    else names.add(name);
  }
  // connection_tools.ts defines find_tools inside a factory, so it has no file of its own.
  for (const match of readFileSync(join(dir, "connection_tools.ts"), "utf8").matchAll(/^\s*([a-z_]+): defineTool\(/gm)) {
    names.add(match[1]!);
  }
  return names;
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
  "botId", "timeoutMs", "timedOut", "exitCode", "status", "blocked", "active", "schedules", "model", "connectionId", "kind", "query",
  "updateSection", "removeSection", "list", "install", "todos", "sectionId", "all", "format", "text", "markdown", "html",
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
