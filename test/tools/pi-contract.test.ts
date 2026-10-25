import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { allTools } from "../../agent/tools/index.ts";
import type { CtxResolver, UsefulTool } from "../../agent/lib/tool.ts";
import { fakeCtx } from "./ctx.ts";

// SPEC 5.8 and contract test 9: the 16 tools, their order, which run one at a
// time, and that every schema compiles with Pi's own validator.

const NAMES = [
  "bash", "read_file", "write_file", "list_dir", "web_search", "web_fetch", "memory", "routine",
  "apps", "connect_server", "find_tools", "generate_image", "install_cli", "todo", "ask", "load_skill",
];
const SEQUENTIAL = new Set(["bash", "write_file", "memory", "routine", "apps", "connect_server", "find_tools", "generate_image", "install_cli", "todo", "ask"]);

/** One call each tool must accept as it stands. */
const VALID: Record<string, Record<string, unknown>> = {
  bash: { command: "ls" },
  read_file: { path: "a.txt" },
  write_file: { path: "a.txt", content: "x" },
  list_dir: {},
  web_search: { query: "cats" },
  web_fetch: { url: "https://example.com/" },
  memory: { action: "search", query: "x" },
  routine: { action: "list" },
  apps: { action: "find", query: "gmail" },
  connect_server: { url: "https://mcp.example.com/mcp" },
  find_tools: { query: "draw" },
  generate_image: { prompt: "a cat" },
  install_cli: { action: "list" },
  todo: {},
  ask: { prompt: "Which one?", options: [{ id: "a", label: "A" }] },
  load_skill: { name: "connect-apps" },
};

function asPiTool(tool: UsefulTool) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters as never };
}

function call(tool: UsefulTool, args: Record<string, unknown>) {
  const prepared = tool.prepareArguments(args) as never;
  return validateToolArguments(asPiTool(tool), { type: "toolCall", id: "c", name: tool.name, arguments: prepared });
}

test("allTools lists the 16 declared tools in the fixed order", () => {
  assert.deepEqual(allTools().map((tool) => tool.name), NAMES);
  assert.equal(new Set(allTools().map((tool) => tool.name)).size, 16);
});

test("every gated or stateful tool runs sequentially, every read-only one does not", () => {
  const resolve: CtxResolver = () => { throw new Error("not called"); };
  for (const tool of allTools()) {
    const definition = tool.toPiTool(resolve) as unknown as { executionMode?: string; name: string };
    assert.equal(definition.executionMode === "sequential", SEQUENTIAL.has(tool.name), `${tool.name}: sequential`);
    assert.equal(tool.sequential === true, SEQUENTIAL.has(tool.name), `${tool.name}: spec flag`);
  }
});

test("every tool's schema is a plain object schema that compiles with Pi's validator", () => {
  for (const tool of allTools()) {
    assert.equal(tool.parameters.type, "object", tool.name);
    assert.equal("$schema" in tool.parameters, false, `${tool.name} carries $schema`);
    const valid = VALID[tool.name];
    assert.ok(valid, `no sample call for ${tool.name}`);
    assert.doesNotThrow(() => call(tool, valid), `${tool.name} refused its own sample call`);
  }
});

test("a call with a wrong type fails validation, not compilation", () => {
  for (const tool of allTools()) {
    const required = (tool.parameters.required ?? []) as string[];
    if (required.length === 0) continue;
    assert.throws(() => call(tool, {}), /Validation failed/, `${tool.name}: missing ${required.join(", ")}`);
  }
});

test("the lenient fields get through Pi's validator on every tool that has them", () => {
  const memory = allTools().find((tool) => tool.name === "memory") as UsefulTool;
  const write = allTools().find((tool) => tool.name === "write_file") as UsefulTool;
  assert.doesNotThrow(() => call(memory, { action: "save", title: "t", body: "b", expectedRevision: "null", expiresAt: "null" }));
  assert.doesNotThrow(() => call(memory, { action: "delete", id: "a", expectedRevision: "4" }));
  assert.doesNotThrow(() => call(write, { path: "a", content: "x", expectedSha256: "null" }));
});

test("toPiTool runs the tool with the context the host resolves and shapes its result", async () => {
  const ctx = fakeCtx({ chatId: "chat-pi", callId: "call-pi" });
  const seen: string[] = [];
  const resolve: CtxResolver = (callId) => {
    seen.push(callId);
    return ctx;
  };
  const byName = (name: string) => allTools().find((tool) => tool.name === name) as UsefulTool;
  const run = async (name: string, args: Record<string, unknown>) =>
    (byName(name).toPiTool(resolve) as unknown as { execute: (id: string, params: unknown, signal: AbortSignal | undefined, update: unknown, pi: unknown) => Promise<{ content: { text: string }[]; details: unknown; terminate?: boolean }> })
      .execute("call-pi", args, undefined, undefined, {});

  const skill = await run("load_skill", { name: "about-useful-bot" });
  assert.match(skill.content[0].text, /Answer from these facts only/);
  assert.equal(skill.terminate, undefined);

  // ask: a question in the details, and the batch ends the turn.
  const asked = await run("ask", { prompt: "Which folder?", options: [{ id: "a", label: "Docs" }, { id: "b", label: "Code", detail: "the repo" }] });
  assert.equal(asked.terminate, true);
  assert.match(asked.content[0].text, /next message/);
  const question = (asked.details as { question: { requestId: string; prompt: string; options: unknown[]; allowFreeform: boolean } }).question;
  assert.match(question.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(question.prompt, "Which folder?");
  assert.equal(question.options.length, 2);
  assert.equal(question.allowFreeform, true);
  const again = await run("ask", { prompt: "Which folder?", allowFreeform: false });
  assert.notEqual((again.details as { question: { requestId: string } }).question.requestId, question.requestId);
  assert.deepEqual((again.details as { question: { options: unknown[]; allowFreeform: boolean } }).question.options, []);
  assert.equal((again.details as { question: { allowFreeform: boolean } }).question.allowFreeform, false);

  assert.deepEqual(seen, ["call-pi", "call-pi", "call-pi"]);
});

test("todo keeps the whole list in each result's details and answers a read from it", async () => {
  const ctx = fakeCtx({ chatId: "chat-todo" });
  const todo = allTools().find((tool) => tool.name === "todo") as UsefulTool;
  const first = [
    { content: "one", priority: "high", status: "in_progress" },
    { content: "two", priority: "low", status: "pending" },
  ];
  const wrote = await todo.execute({ todos: first }, ctx) as { details: { todos: unknown[] } };
  assert.deepEqual(wrote.details.todos, first);
  const read = await todo.execute({}, ctx) as { details: { todos: unknown[] }; content: { text: string }[] };
  assert.deepEqual(read.details.todos, first);
  assert.deepEqual(JSON.parse(read.content[0].text), { todos: first });
  // Another chat has its own list.
  const other = await todo.execute({}, fakeCtx({ chatId: "chat-other" })) as { details: { todos: unknown[] } };
  assert.deepEqual(other.details.todos, []);
  // Replacing is a whole-list write.
  const replaced = await todo.execute({ todos: [] }, ctx) as { details: { todos: unknown[] } };
  assert.deepEqual(replaced.details.todos, []);
  assert.throws(() => todo.inputSchema.parse({ todos: [{ content: "x", priority: "urgent", status: "pending" }] }));
  assert.throws(() => todo.inputSchema.parse({ extra: true }));
});

test("web_search returns the results as details for the app's chips and the text fenced", async () => {
  const search = allTools().find((tool) => tool.name === "web_search") as UsefulTool;
  const realFetch = globalThis.fetch;
  const before = process.env.UB_ROUTER_DESKTOP_TOKEN;
  process.env.UB_ROUTER_DESKTOP_TOKEN = "test-token";
  let seenSession: string | null = null;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seenSession = new Headers(init?.headers).get("x-useful-session-id");
    return new Response(JSON.stringify({
      results: [
        { title: "Cats", url: "https://cats.example.com/", snippet: "All about cats" },
        { title: "No url", snippet: "dropped" },
      ],
      provider: "p",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const out = await search.execute({ query: "cats" }, fakeCtx()) as { content: { text: string }[]; details: { searchResults: unknown[] } };
    assert.deepEqual(out.details.searchResults, [{ title: "Cats", url: "https://cats.example.com/", snippet: "All about cats" }]);
    assert.match(out.content[0].text, /untrusted/i);
    assert.match(out.content[0].text, /All about cats/);
    assert.match(seenSession ?? "", /^[0-9a-f-]{36}$/);
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.UB_ROUTER_DESKTOP_TOKEN;
    else process.env.UB_ROUTER_DESKTOP_TOKEN = before;
  }
});
