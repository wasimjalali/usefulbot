import assert from "node:assert/strict";
import test from "node:test";
import {
  createThinkStream,
  flushThinkStream,
  noteInlineThink,
  rewrapThinkHistory,
  splitThinkBlock,
  splitThinkCompletion,
  usesInlineThink,
} from "../router/src/inline-think.ts";
import { THINK_TAGS, scanThink, splitLeadingThink } from "../shared/inline-think.ts";

// Some models (MiniMax M3 through OpenCode, MiniMax's own API by default)
// write their thinking into the answer as `<think>…</think>` instead of the
// reasoning field. These are the ways splitting that out can go wrong.

type Delta = Record<string, unknown>;

function block(delta: Delta, extra: Record<string, unknown> = {}, index = 0): string {
  return `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "workhorse", choices: [{ index, delta, ...extra }] })}`;
}

/** Everything the client would read back, per choice, from the relayed blocks. */
function read(out: string[]): { content: string; reasoning: string; finish: string | null; done: boolean; toolCalls: number } {
  let content = "";
  let reasoning = "";
  let finish: string | null = null;
  let done = false;
  let toolCalls = 0;
  for (const chunk of out) {
    for (const event of chunk.split(/\n\n/)) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          done = true;
          continue;
        }
        const payload = JSON.parse(data);
        for (const choice of payload.choices ?? []) {
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string") content += delta.content;
          if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
          if (Array.isArray(delta.tool_calls)) toolCalls += delta.tool_calls.length;
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
    }
  }
  return { content, reasoning, finish, done, toolCalls };
}

function relay(pieces: string[], opts: { finish?: string; done?: boolean; flush?: boolean } = {}): { result: ReturnType<typeof read>; found: number } {
  let found = 0;
  const stream = createThinkStream(() => { found += 1; });
  const out: string[] = [];
  for (const piece of pieces) out.push(splitThinkBlock(block({ content: piece }), stream));
  if (opts.finish) out.push(splitThinkBlock(block({}, { finish_reason: opts.finish }), stream));
  if (opts.done ?? true) out.push(splitThinkBlock("data: [DONE]", stream));
  if (opts.flush) {
    const held = flushThinkStream(stream);
    if (held) out.push(held);
  }
  return { result: read(out), found };
}

test("a think block cut across chunks becomes reasoning, the answer stays text", () => {
  const { result, found } = relay(["<thi", "nk>Plan the ", "reply.</th", "ink>\n\nHello", " there."], { finish: "stop" });
  assert.equal(result.reasoning, "Plan the reply.");
  assert.equal(result.content, "Hello there.");
  assert.equal(result.finish, "stop");
  assert.equal(result.done, true);
  assert.equal(found, 1);
});

test("every single-character split still lands whole", () => {
  const raw = "  <think>a < b and </thin is not a close</think>\n\nAnswer <b>bold</b>.";
  const { result } = relay([...raw], { finish: "stop" });
  assert.equal(result.reasoning, "a < b and </thin is not a close");
  assert.equal(result.content, "Answer <b>bold</b>.");
});

test("the <thinking> spelling is split the same way", () => {
  const { result } = relay(["<thinking>step</thinking>Done"], { finish: "stop" });
  assert.equal(result.reasoning, "step");
  assert.equal(result.content, "Done");
});

test("an answer that opens with a different tag is left exactly as sent", () => {
  for (const pieces of [["<", "div>hi</div>"], ["<th", "ead>"], ["<3 thanks"], ["<thin", "k about it"], ["\n\n", "Plain"]]) {
    const { result, found } = relay(pieces, { finish: "stop" });
    assert.equal(result.content, pieces.join(""), JSON.stringify(pieces));
    assert.equal(result.reasoning, "");
    assert.equal(found, 0);
  }
});

test("a think tag in the middle of an answer is the answer's own text", () => {
  const { result, found } = relay(["Use ", "<think>", " tags like this: <think>x</think>"], { finish: "stop" });
  assert.equal(result.content, "Use <think> tags like this: <think>x</think>");
  assert.equal(result.reasoning, "");
  assert.equal(found, 0);
});

test("a stream cut inside the thinking loses nothing and shows no text", () => {
  const { result } = relay(["<think>long thought that never", " ends </thi"], { finish: "length" });
  assert.equal(result.reasoning, "long thought that never ends </thi");
  assert.equal(result.content, "");
  assert.equal(result.finish, "length");
});

test("a stream that ends on half an opening tag still delivers it as text", () => {
  const { result } = relay(["<th"], { finish: "stop" });
  assert.equal(result.content, "<th");
  assert.equal(result.reasoning, "");
});

test("held text is flushed before [DONE] when no finish reason came", () => {
  const { result } = relay(["<think>tho", "ught</thi"], { done: true });
  assert.equal(result.reasoning, "thought</thi");
  assert.equal(result.done, true);
});

test("a stream with neither finish reason nor [DONE] gives up held text at the end", () => {
  const { result } = relay(["<th"], { done: false, flush: true });
  assert.equal(result.content, "<th");
});

test("thinking followed only by a tool call leaves no text behind", () => {
  const stream = createThinkStream();
  const out = [
    splitThinkBlock(block({ role: "assistant", content: "<think>Need the file.</think>\n\n" }), stream),
    splitThinkBlock(block({ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] }), stream),
    splitThinkBlock(block({}, { finish_reason: "tool_calls" }), stream),
    splitThinkBlock("data: [DONE]", stream),
  ];
  const result = read(out);
  assert.equal(result.reasoning, "Need the file.");
  assert.equal(result.content, "");
  assert.equal(result.toolCalls, 1);
  assert.equal(result.finish, "tool_calls");
});

test("a chunk that already carries reasoning keeps it, ahead of the split thinking", () => {
  const stream = createThinkStream();
  const out = [splitThinkBlock(block({ reasoning_content: "native ", content: "<think>inline</think>ok" }), stream)];
  const result = read(out);
  assert.equal(result.reasoning, "native inline");
  assert.equal(result.content, "ok");
});

test("a chunk that uses the `reasoning` field keeps a single reasoning field", () => {
  const stream = createThinkStream();
  const out = splitThinkBlock(block({ reasoning: "native ", content: "<think>inline</think>ok" }), stream);
  const delta = JSON.parse(out.slice(5)).choices[0].delta;
  assert.equal(delta.reasoning, "native inline");
  assert.equal(delta.reasoning_content, undefined);
});

test("an empty think block leaves the answer untouched", () => {
  const { result } = relay(["<think></think>", "\n\nHi"], { finish: "stop" });
  assert.equal(result.reasoning, "");
  assert.equal(result.content, "Hi");
});

test("the answer's own inner whitespace survives, only the gap after thinking goes", () => {
  const { result } = relay(["<think>x</think>\n\n", "\n", "Line one\n\n  Line two"], { finish: "stop" });
  assert.equal(result.content, "Line one\n\n  Line two");
});

test("each choice keeps its own state", () => {
  const stream = createThinkStream();
  const out = [
    splitThinkBlock(block({ content: "<think>a" }, {}, 0), stream),
    splitThinkBlock(block({ content: "Plain" }, {}, 1), stream),
    splitThinkBlock(block({ content: "</think>A" }, {}, 0), stream),
  ];
  const texts: Record<number, { c: string; r: string }> = { 0: { c: "", r: "" }, 1: { c: "", r: "" } };
  for (const chunk of out) {
    const choice = JSON.parse(chunk.slice(5)).choices[0];
    texts[choice.index].c += choice.delta.content ?? "";
    texts[choice.index].r += choice.delta.reasoning_content ?? "";
  }
  assert.deepEqual(texts, { 0: { c: "A", r: "a" }, 1: { c: "Plain", r: "" } });
});

test("blocks that carry no content come back byte for byte", () => {
  const stream = createThinkStream();
  const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } })}`;
  assert.equal(splitThinkBlock(usage, stream), usage);
  assert.equal(splitThinkBlock(": keep-alive", stream), ": keep-alive");
  assert.equal(splitThinkBlock("data: not json", stream), "data: not json");
  // Once the answer is under way, text blocks pass straight through.
  splitThinkBlock(block({ content: "Hello" }), stream);
  const later = block({ content: " <think>" });
  assert.equal(splitThinkBlock(later, stream), later);
});

test("a stream that already sends native reasoning is split but not learned", () => {
  let found = 0;
  const stream = createThinkStream(() => { found += 1; });
  splitThinkBlock(block({ reasoning_content: "native thought" }), stream);
  const out = splitThinkBlock(block({ content: "<think>quoted</think>Answer" }), stream);
  const delta = JSON.parse(out.slice(5)).choices[0].delta;
  assert.equal(delta.content, "Answer");
  assert.equal(found, 0);
});

test("a flood of leading whitespace is released instead of held", () => {
  const stream = createThinkStream();
  const spaces = " ".repeat(300);
  const out = splitThinkBlock(block({ content: spaces }), stream);
  assert.equal(JSON.parse(out.slice(5)).choices[0].delta.content, spaces);
  const later = block({ content: "<think>x</think>" });
  assert.equal(splitThinkBlock(later, stream), later);
});

// Found live on 2026-09-25: MiniMax M3, asked about this very file, quoted the
// tag pair inside its thinking, and the quoted close ended the block early.
test("a tag pair quoted inside the thinking does not end it", () => {
  const raw = "<think>The file handles `<think>…</think>` blocks in model outputs. Answer in three sentences.</think>\n\nThe file has 298 lines.";
  for (const pieces of [[raw], [...raw]]) {
    const { result } = relay(pieces, { finish: "stop" });
    assert.equal(result.reasoning, "The file handles `<think>…</think>` blocks in model outputs. Answer in three sentences.");
    assert.equal(result.content, "The file has 298 lines.");
  }
});

test("a lone quoted opening tag does not swallow the answer", () => {
  const { result } = relay(["<think>The tag <think> opens it.</think>\n", "\nAnswer"], { finish: "stop" });
  assert.equal(result.reasoning, "The tag <think> opens it.");
  assert.equal(result.content, "Answer");
});

test("an answer straight after the real close still splits when a pair was quoted", () => {
  const { result } = relay(["<think>use <think>x</think> here</think>Done"], { finish: "stop" });
  assert.equal(result.reasoning, "use <think>x</think> here");
  assert.equal(result.content, "Done");
});

test("a message that ends on its close after a lone quoted tag is all thinking", () => {
  const { result } = relay(["<think>mention <think> only</think>"], { finish: "tool_calls" });
  assert.equal(result.reasoning, "mention <think> only");
  assert.equal(result.content, "");
});

// PR #135 review: a lone quoted opening tag whose real close is not followed
// by a blank line swallowed the whole answer.
test("a lone quoted open never swallows the answer, whatever follows the close", () => {
  for (const [raw, thinking, answer] of [
    ["<think>The user asks what <think> does.</think>\nThe <think> tag opens a block.", "The user asks what <think> does.", "The <think> tag opens a block."],
    ["<think>what <think> does</think>Answer here", "what <think> does", "Answer here"],
    ["<think>what <think> does</think> Answer", "what <think> does", "Answer"],
    ["<think>a <think> b</think>\r\n\r\nAnswer", "a <think> b", "Answer"],
  ]) {
    for (const pieces of [[raw], [...raw]]) {
      const { result } = relay(pieces, { finish: "stop" });
      assert.equal(result.reasoning, thinking, JSON.stringify(raw));
      assert.equal(result.content, answer, JSON.stringify(raw));
    }
    assert.deepEqual(splitLeadingThink(raw), { thinking, answer });
  }
});

test("a reply cut off by the length limit stays thinking even after a quoted pair", () => {
  const { result } = relay(["<think>use <think>x</think> and then cut"], { finish: "length" });
  assert.equal(result.reasoning, "use <think>x</think> and then cut");
  assert.equal(result.content, "");
});

test("held text after a quoted close is released on [DONE] and at stream end", () => {
  const raw = "<think>what <think> does</think>\nAnswer";
  assert.equal(relay([...raw], { done: true }).result.content, "Answer");
  assert.equal(relay([...raw], { done: false, flush: true }).result.content, "Answer");
});

test("thinking held after a quoted close is let go past the cap, and the block still ends", () => {
  const raw = "<think>q <think>x</think> " + "t".repeat(17000) + "</think>\n\nAnswer";
  const pieces: string[] = [];
  for (let i = 0; i < raw.length; i += 64) pieces.push(raw.slice(i, i + 64));
  const { result } = relay(pieces, { finish: "stop" });
  assert.equal(result.reasoning, "q <think>x</think> " + "t".repeat(17000));
  assert.equal(result.content, "Answer");
});

test("a whitespace run after a quoted close is not held once it cannot become a blank line", () => {
  let scan = scanThink("x</think>   \t  more", THINK_TAGS[0], 2, "stream");
  assert.deepEqual(scan, { closed: false, safe: 1, depth: 2 });
  scan = scanThink("x</think>   \t  ", THINK_TAGS[0], 2, "stream", true);
  assert.deepEqual(scan, { closed: false, safe: 15, depth: 1 });
  scan = scanThink("x</think>\n", THINK_TAGS[0], 2, "stream", true);
  assert.deepEqual(scan, { closed: false, safe: 1, depth: 2 });
});

test("a streamed reply splits exactly as the whole text does", () => {
  const texts = [
    "<think>mention <think> only</think> ",
    "<think>mention <think> only</think>\t",
    "<think>mention <think> only</think>\r\n",
    "<think>x <think>y</think> z</think>\n\nA",
    "<think>x <think>y</think>\n\nleaks by design</think>A",
    "<thinking>q <thinking>r</thinking> s</thinking>Done",
    "<think>a <thinking> b</think>C",
    "<think>open <think> open <think> close</think> close</think>\nEnd",
    "<think>plain</think>\n\nAnswer with </think> inside",
  ];
  for (const raw of texts) {
    const whole = splitLeadingThink(raw);
    assert.ok(whole, raw);
    for (const pieces of [[raw], [...raw]]) {
      const { result } = relay(pieces, { finish: "stop" });
      assert.equal(result.reasoning, whole.thinking, JSON.stringify(raw));
      assert.equal(result.content, whole.answer, JSON.stringify(raw));
    }
  }
});

test("a non-streamed reply is split the same way", () => {
  const json = { choices: [{ index: 0, message: { role: "assistant", content: "\n<think>why</think>\n\nBecause." }, finish_reason: "stop" }] };
  assert.equal(splitThinkCompletion(json), true);
  assert.deepEqual(json.choices[0].message, { role: "assistant", content: "Because.", reasoning_content: "why" });

  const unclosed = { choices: [{ message: { role: "assistant", content: "<think>cut off" } }] };
  splitThinkCompletion(unclosed);
  assert.deepEqual(unclosed.choices[0].message, { role: "assistant", content: "", reasoning_content: "cut off" });

  const plain = { choices: [{ message: { role: "assistant", content: "Use <think> tags." } }] };
  assert.equal(splitThinkCompletion(plain), false);
  assert.equal(plain.choices[0].message.content, "Use <think> tags.");

  // Split but not reported: the model already fills the reasoning field.
  const native = { choices: [{ message: { role: "assistant", content: "<think>q</think>A", reasoning_content: "native " } }] };
  assert.equal(splitThinkCompletion(native), false);
  assert.deepEqual(native.choices[0].message, { role: "assistant", content: "A", reasoning_content: "native q" });

  const tools = { choices: [{ message: { role: "assistant", content: null, tool_calls: [] } }] };
  assert.equal(splitThinkCompletion(tools), false);
});

test("history goes back as inline thinking only to models that wrote it that way", () => {
  noteInlineThink("opencode-go", "minimax-m3");
  assert.equal(usesInlineThink("opencode-go", "minimax-m3"), true);
  assert.equal(usesInlineThink("opencode-go", "minimax-m2.7"), false);
  assert.equal(usesInlineThink("minimax", "minimax-m3"), false);

  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hello", reasoning_content: "greet" },
    { role: "assistant", content: null, reasoning_content: "need a file", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", content: "data" },
    { role: "assistant", content: "<think>old</think>\n\nStored before the fix" },
    { role: "assistant", content: "No thinking" },
    { role: "assistant", content: [{ type: "text", text: "parts" }], reasoning_content: "kept apart" },
  ];
  const out = rewrapThinkHistory(history) as Array<Record<string, unknown>>;
  assert.deepEqual(out[1], { role: "assistant", content: "<think>greet</think>\n\nHello" });
  assert.deepEqual(out[2], { role: "assistant", content: "<think>need a file</think>", tool_calls: history[2].tool_calls });
  assert.deepEqual(out[4], history[4]);
  assert.deepEqual(out[5], history[5]);
  assert.equal(out[6], history[6]);
  assert.equal(out[0], history[0]);
  // The caller's history is not mutated.
  assert.equal(history[1].reasoning_content, "greet");
});

