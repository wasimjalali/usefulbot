import assert from "node:assert/strict";
import test from "node:test";
import { allTools } from "../../agent/tools/index.ts";
import { loadDeps } from "../../agent/engine/deps.ts";
import { makeWorld } from "./helpers.ts";

/** The engine with the real tools, skills and stores underneath: what the shipped app runs, minus the model. */

test("the real wiring loads: every seam the engine needs is there", async () => {
  const deps = await loadDeps();
  assert.equal(deps.allTools().length, 16);
  assert.equal(typeof deps.pickedTools, "function");
  assert.ok(deps.listSkills().some((skill) => skill.name === "about-useful-bot"));
});

test("the 16 real tools are declared, ask ends the turn with a card, todo and load_skill work", async () => {
  const deps = await loadDeps();
  const world = await makeWorld({ deps });
  try {
    const chatId = world.newChat();
    world.router.enqueue(
      { kind: "tools", calls: [{ name: "todo", args: { todos: [{ content: "Check the plan", priority: "high", status: "in_progress" }] } }] },
      { kind: "tools", calls: [{ name: "load_skill", args: { name: "about-useful-bot" } }] },
      { kind: "tools", text: "One question.", calls: [{ name: "ask", args: { prompt: "Which folder?", options: [{ id: "desk", label: "Desktop" }] } }] },
    );
    const recorder = world.record(chatId);
    world.send(chatId, "plan something");
    await world.idle(chatId);

    const declared = (world.router.requests[0].body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    assert.deepEqual(declared, allTools().map((tool) => tool.name), "the model is shown exactly the 16, in their fixed order");
    assert.equal(world.router.requests.length, 3, "ask ended the turn");
    assert.deepEqual(world.router.refused, []);

    const results = recorder.events.filter((event) => event.type === "tool.result");
    assert.deepEqual(results.map((event) => [event.name, event.isError]), [["todo", false], ["load_skill", false], ["ask", false]]);
    const todo = (world.router.requests[1].body.messages as { role: string; content: unknown }[]).filter((message) => message.role === "tool")[0];
    assert.match(JSON.stringify(todo.content), /Check the plan/);
    const skill = (world.router.requests[2].body.messages as { role: string; content: unknown }[]).filter((message) => message.role === "tool")[1];
    assert.match(JSON.stringify(skill.content), /Useful Bot/);

    const requested = recorder.events.find((event) => event.type === "input.requested");
    assert.equal(requested?.prompt, "Which folder?");
    assert.deepEqual(requested?.options, [{ id: "desk", label: "Desktop" }]);
    assert.equal(requested?.allowFreeform, true);
    const page = world.engine.rows(chatId, {});
    assert.equal(page.openQuestion?.prompt, "Which folder?");
    const question = page.rows.find((row) => row.kind === "question");
    assert.equal(question && "requestId" in question ? question.requestId : null, requested?.requestId);
    assert.equal(world.engine.status().chats[0].waitingOnOwner, "question");

    // The answer is the next message; the todo list is still on the branch after the chat is reopened.
    world.engine.host.chat(chatId).evict();
    world.router.enqueue({ kind: "tools", calls: [{ name: "todo", args: {} }] }, { kind: "text", text: "Desktop it is." });
    world.send(chatId, "Desktop");
    await world.idle(chatId);
    const reread = (world.router.requests.at(-1)?.body.messages as { role: string; content: unknown }[]).filter((message) => message.role === "tool").at(-1);
    assert.match(JSON.stringify(reread?.content), /Check the plan/, "the list came back from the session file");
    assert.equal(world.engine.status().chats[0].waitingOnOwner, null);
  } finally {
    await world.close();
  }
});

test("the real tools' schemas, the real prompt and a small window: admission says what fits", async () => {
  const deps = await loadDeps();
  const world = await makeWorld({ deps, window: 32_768 });
  try {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "text", text: "fits in the smallest window" });
    world.send(chatId, "hello");
    await world.idle(chatId);
    const system = (world.router.requests[0].body.messages as { role: string; content: string }[])[0];
    assert.ok(system.content.includes("about-useful-bot"), "the real skills are listed");
    const tools = JSON.stringify(world.router.requests[0].body.tools).length;
    assert.ok(tools < 21_000, `the declared tools are ${tools} characters`);
    const context = world.engine.botContext("bot-useful");
    assert.ok(context.envelopeTokens < context.windowTokens, `${context.envelopeTokens} of ${context.windowTokens}`);
  } finally {
    await world.close();
  }
});
