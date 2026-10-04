// Some models write their thinking into the answer as `<think>…</think>`
// instead of the reasoning field: MiniMax M3 through OpenCode does, and so
// does MiniMax's own API unless asked otherwise. The AI SDK only reads the
// field, so the thinking reached eve as answer text and both apps showed it
// in the bubble. A think block that opens a message is moved into the
// reasoning field here, for any model, so it lands where every other model's
// thinking does. A tag further into the answer is left alone: that is the
// model writing about tags.
//
// Those models also expect their thinking back in the history the same way
// (MiniMax's docs: keep the thinking in `content`, unmodified), so a model
// seen doing this gets its reasoning re-wrapped into the content it sends.

import { MAX_HELD_QUOTED, THINK_TAGS, scanThink, splitLeadingThink, type ThinkTag } from "../../shared/inline-think.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `start`: nothing but whitespace or the first characters of an opening tag
 * yet, held back until it is clear which. `inside`: in the think block, with
 * any partial closing tag held back. `gap`: past the block, dropping the
 * blank lines before the answer. `text`: the answer, passed through.
 */
type Mode = "start" | "inside" | "gap" | "text";

interface ChoiceState {
  mode: Mode;
  held: string;
  tag: ThinkTag;
  /** Open think tags of this kind, counting quoted ones inside the thinking. */
  depth: number;
  /** Set once text held after a quoted close grew too long and was let go. */
  passQuoted: boolean;
}

export interface ThinkStream {
  choices: Map<number, ChoiceState>;
  found: boolean;
  /** The upstream sent its own reasoning field: the model is not an inline thinker. */
  native: boolean;
  onFound?: () => void;
  /** The last chunk's envelope, for a chunk the router has to add itself. */
  template: Record<string, unknown> | null;
}

/** Per stream. `onFound` runs once, the first time a think block opens. */
export function createThinkStream(onFound?: () => void): ThinkStream {
  return { choices: new Map(), found: false, native: false, onFound, template: null };
}

/** Whitespace held while waiting to see whether a tag opens the message. */
const MAX_HELD_START = 256;

interface Split {
  content: string;
  reasoning: string;
}

function feed(stream: ThinkStream, state: ChoiceState, piece: string): Split {
  const out: Split = { content: "", reasoning: "" };
  let rest = piece;
  while (rest) {
    if (state.mode === "start") {
      const text = state.held + rest;
      rest = "";
      const trimmed = text.trimStart();
      const tag = THINK_TAGS.find((candidate) => trimmed.startsWith(candidate.open));
      if (tag) {
        state.mode = "inside";
        state.tag = tag;
        state.depth = 1;
        state.passQuoted = false;
        state.held = "";
        rest = trimmed.slice(tag.open.length);
        // A model that already fills the reasoning field and opens one
        // answer with a tag is not learned: its history keeps the field.
        if (!stream.found && !stream.native) {
          stream.found = true;
          stream.onFound?.();
        }
      } else if (THINK_TAGS.some((candidate) => candidate.open.startsWith(trimmed)) && text.length <= MAX_HELD_START) {
        state.held = text;
      } else {
        state.mode = "text";
        state.held = "";
        out.content += text;
      }
    } else if (state.mode === "inside") {
      const text = state.held + rest;
      rest = "";
      let scan = scanThink(text, state.tag, state.depth, "stream", state.passQuoted);
      if (!scan.closed && text.length - scan.safe > MAX_HELD_QUOTED) {
        // Held long enough to be thinking after a quoted pair: let it go and
        // stop holding for the rest of the block.
        state.passQuoted = true;
        scan = scanThink(text, state.tag, state.depth, "stream", true);
      }
      if (scan.closed) {
        out.reasoning += text.slice(0, scan.end);
        state.held = "";
        state.mode = "gap";
        rest = text.slice(scan.after);
      } else {
        // A tag, or a close still waiting on what follows it, is held back.
        out.reasoning += text.slice(0, scan.safe);
        state.held = text.slice(scan.safe);
        state.depth = scan.depth;
      }
    } else if (state.mode === "gap") {
      const trimmed = rest.trimStart();
      rest = "";
      if (trimmed) {
        state.mode = "text";
        out.content += trimmed;
      }
    } else {
      out.content += rest;
      rest = "";
    }
  }
  return out;
}

/**
 * What a choice still holds when its stream ends: text before a tag was
 * clear, thinking inside one, or an answer after a quoted close. A reply cut
 * at the length limit keeps it all as thinking.
 */
function flush(state: ChoiceState, finish?: string): Split {
  const out: Split = { content: "", reasoning: "" };
  if (state.mode === "start") out.content = state.held;
  else if (state.mode === "inside") {
    const scan = scanThink(state.held, state.tag, state.depth, finish === "length" ? "cut" : "done", state.passQuoted);
    if (scan.closed) {
      out.reasoning = state.held.slice(0, scan.end);
      out.content = state.held.slice(scan.after).trimStart();
    } else {
      out.reasoning = state.held;
    }
  }
  state.mode = "text";
  state.held = "";
  return out;
}

/**
 * Split thinking goes into whichever reasoning field the chunk already uses,
 * after what it already holds; the SDK reads `reasoning_content` over
 * `reasoning`, so filling the other one would hide the first.
 */
function addReasoning(delta: Record<string, unknown>, reasoning: string): void {
  if (!reasoning) return;
  if (typeof delta.reasoning_content === "string") delta.reasoning_content += reasoning;
  else if (typeof delta.reasoning === "string") delta.reasoning += reasoning;
  else delta.reasoning_content = reasoning;
}

function settled(stream: ThinkStream): boolean {
  if (stream.choices.size === 0) return false;
  for (const state of stream.choices.values()) if (state.mode !== "text") return false;
  return true;
}

/** Everything the stream still holds, as one chunk of its own, or null. */
export function flushThinkStream(stream: ThinkStream): string | null {
  const choices: Array<Record<string, unknown>> = [];
  for (const [index, state] of stream.choices) {
    const held = flush(state);
    if (!held.content && !held.reasoning) continue;
    const delta: Record<string, unknown> = {};
    if (held.content) delta.content = held.content;
    addReasoning(delta, held.reasoning);
    choices.push({ index, delta, finish_reason: null });
  }
  if (choices.length === 0 || !stream.template) return null;
  return `data: ${JSON.stringify({ ...stream.template, choices })}`;
}

/**
 * One SSE block of a chat-completions stream, with a leading think block
 * moved into the reasoning field. Held text is released on the choice's
 * finish reason, or before `[DONE]` when none came. A choice that first
 * appears after every earlier one reached its answer passes through as it
 * is; eve never asks for more than one.
 */
export function splitThinkBlock(block: string, stream: ThinkStream): string {
  // Once the answer is under way, blocks pass straight through unparsed.
  if (settled(stream) && !block.includes("[DONE]")) return block;
  let changed = false;
  const lines = block.split("\n").map((line) => {
    if (!line.startsWith("data:")) return line;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      const held = flushThinkStream(stream);
      if (!held) return line;
      changed = true;
      return `${held}\n\n${line}`;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return line;
    }
    if (!isRecord(payload) || !Array.isArray(payload.choices)) return line;
    const { choices: _choices, usage: _usage, ...envelope } = payload;
    stream.template = envelope;
    let touched = false;
    for (const choice of payload.choices) {
      if (!isRecord(choice)) continue;
      const index = typeof choice.index === "number" ? choice.index : 0;
      let state = stream.choices.get(index);
      if (!state) {
        state = { mode: "start", held: "", tag: THINK_TAGS[0], depth: 0, passQuoted: false };
        stream.choices.set(index, state);
      }
      if (state.mode === "text") continue;
      const delta = isRecord(choice.delta) ? choice.delta : null;
      if (delta && ((typeof delta.reasoning_content === "string" && delta.reasoning_content)
        || (typeof delta.reasoning === "string" && delta.reasoning))) {
        stream.native = true;
      }
      const split: Split = { content: "", reasoning: "" };
      let hadContent = false;
      if (delta && typeof delta.content === "string") {
        hadContent = true;
        const got = feed(stream, state, delta.content);
        split.content += got.content;
        split.reasoning += got.reasoning;
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        const held = flush(state, choice.finish_reason);
        split.content += held.content;
        split.reasoning += held.reasoning;
      }
      if (!hadContent && !split.content && !split.reasoning) continue;
      const target = delta ?? {};
      if (hadContent || split.content) target.content = split.content;
      addReasoning(target, split.reasoning);
      choice.delta = target;
      touched = true;
    }
    if (!touched) return line;
    changed = true;
    return `data: ${JSON.stringify(payload)}`;
  });
  return changed ? lines.join("\n") : block;
}

/**
 * The same split for a non-streamed completion, in place. True when a block
 * was found in a message that had no reasoning of its own, the case worth
 * learning the model from.
 */
export function splitThinkCompletion(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return false;
  let found = false;
  for (const choice of payload.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const message = choice.message;
    if (typeof message.content !== "string") continue;
    const split = splitLeadingThink(message.content, choice.finish_reason === "length" ? "cut" : "done");
    if (!split) continue;
    const native = (typeof message.reasoning_content === "string" && message.reasoning_content)
      || (typeof message.reasoning === "string" && message.reasoning);
    if (!native) found = true;
    message.content = split.answer;
    addReasoning(message, split.thinking);
  }
  return found;
}

// Models seen writing inline thinking, per provider and model. Learned from
// replies rather than listed, so a model that starts doing it is handled
// without a code change; a router restart relearns on the next reply.
const inlineThinkModels = new Set<string>();

function modelKey(providerId: string, model: string): string {
  return `${providerId}\u0000${model}`;
}

/** True the first time a model is seen doing it. */
export function noteInlineThink(providerId: string, model: string): boolean {
  const key = modelKey(providerId, model);
  if (inlineThinkModels.has(key)) return false;
  inlineThinkModels.add(key);
  return true;
}

export function usesInlineThink(providerId: string, model: string): boolean {
  return inlineThinkModels.has(modelKey(providerId, model));
}

/** Index of the last user message, or -1 when there is none. */
export function lastUserIndex(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (isRecord(item) && item.role === "user") return index;
  }
  return -1;
}

const REASONING_PART_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

/** An assistant message without its reasoning field or reasoning parts. */
export function withoutReasoning(item: Record<string, unknown>): Record<string, unknown> {
  const { reasoning_content: _reasoning, ...rest } = item;
  if (Array.isArray(rest.content)) {
    return { ...rest, content: rest.content.filter((part) => !(isRecord(part) && typeof part.type === "string" && REASONING_PART_TYPES.has(part.type))) };
  }
  return rest;
}

/**
 * Reasoning from turns before the last user message goes: a history that
 * crosses a model switch holds reasoning another model wrote, and only the
 * current turn is guaranteed to come from the model now answering. Applies to
 * every protocol. A new array; the caller's messages are not changed.
 */
export function stripEarlierReasoning(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  const turnStart = lastUserIndex(messages) + 1;
  return messages.map((item, index) => (
    index < turnStart && isRecord(item) && item.role === "assistant" ? withoutReasoning(item) : item
  ));
}

/**
 * The history for a model that writes inline thinking: each assistant
 * message's reasoning goes back in front of its content as a think block, the
 * shape the model wrote it in. A message whose content already opens with one
 * (stored before the split) keeps it and drops the duplicate. A new array;
 * the caller's messages are not changed.
 */
export function rewrapThinkHistory(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  // Only the current turn (after the last user message) is re-wrapped: the turn
  // is frozen to one model, so that reasoning is its own. Earlier turns may have
  // been written by another model, and their reasoning is dropped instead.
  const turnStart = lastUserIndex(messages) + 1;
  return messages.map((item, index) => {
    if (!isRecord(item) || item.role !== "assistant") return item;
    if (index < turnStart) return withoutReasoning(item);
    const reasoning = item.reasoning_content;
    if (typeof reasoning !== "string" || !reasoning) return item;
    // Only text or nothing can take a think block in front of it.
    if (item.content !== null && item.content !== undefined && typeof item.content !== "string") return item;
    const { reasoning_content: _reasoning, ...rest } = item;
    const content = typeof rest.content === "string" ? rest.content : "";
    if (splitLeadingThink(content)) return rest;
    return { ...rest, content: content ? `<think>${reasoning}</think>\n\n${content}` : `<think>${reasoning}</think>` };
  });
}
