import { stripThreadPrefix } from "./threads.ts";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  text: string;
  id: string;
};

export type EveEvent = {
  type: string;
  data?: Record<string, unknown>;
  meta?: { id?: string; at?: string };
};

export type SearchChip = {
  title: string;
  url: string;
  snippet: string;
};

export type StreamProjection = {
  messages: ChatMessage[];
  pending: boolean;
  error: string;
  seenIds: Set<string>;
  currentAssistantId: string | null;
  blockOpen: boolean;
  searchHits: SearchChip[];
};

export function createProjection(): StreamProjection {
  return {
    messages: [],
    pending: false,
    error: "",
    seenIds: new Set(),
    currentAssistantId: null,
    blockOpen: false,
    searchHits: [],
  };
}

/**
 * The event text a stream line carries, or null for a blank line, a comment
 * or the end marker. Every line with a payload is one event in eve's count,
 * whether or not it parses, so a reader keeping positions counts these.
 */
export function eveStreamPayload(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!payload || payload === "[DONE]") return null;
  return payload;
}

/**
 * Up to `room` events' worth of lines: `consumed` is how many stream
 * positions they took, `events` the ones this build could read.
 */
export function takeStreamLines(lines: string[], room: number): { events: EveEvent[]; consumed: number } {
  const events: EveEvent[] = [];
  let consumed = 0;
  for (const line of lines) {
    if (consumed >= room) break;
    if (eveStreamPayload(line) === null) continue;
    consumed += 1;
    const event = parseEveStreamLine(line);
    if (event) events.push(event);
  }
  return { events, consumed };
}

export function parseEveStreamLine(line: string): EveEvent | null {
  const payload = eveStreamPayload(line);
  if (payload === null) return null;
  try {
    const parsed = JSON.parse(payload) as EveEvent;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function textField(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseSearchChips(value: unknown): SearchChip[] {
  let payload: unknown = value;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { return []; }
  }
  const rec = asRecord(payload);
  const nested = asRecord(rec?.result) ?? asRecord(rec?.output);
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(rec?.results)
      ? rec.results as unknown[]
      : Array.isArray(nested?.results)
        ? nested.results as unknown[]
        : [];
  const chips: SearchChip[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row) continue;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!url.startsWith("https://") && !url.startsWith("http://")) continue;
    chips.push({
      title: String(row.title ?? url).slice(0, 200),
      url: url.slice(0, 2048),
      snippet: String(row.snippet ?? row.description ?? "").slice(0, 800),
    });
    if (chips.length >= 5) break;
  }
  return chips;
}

export function applyEveEvent(state: StreamProjection, event: EveEvent): StreamProjection {
  const id = event.meta?.id;
  if (id && state.seenIds.has(id)) return state;

  const next: StreamProjection = {
    messages: state.messages.slice(),
    pending: state.pending,
    error: state.error,
    seenIds: new Set(state.seenIds),
    currentAssistantId: state.currentAssistantId,
    blockOpen: state.blockOpen,
    searchHits: state.searchHits.slice(),
  };
  if (id) next.seenIds.add(id);

  switch (event.type) {
    case "turn.started":
      next.pending = true;
      next.error = "";
      next.currentAssistantId = null;
      next.blockOpen = false;
      next.searchHits = [];
      return next;
    case "message.received": {
      // Eve stores the rewritten turn, so strip the identity prefix before the
      // owner sees it; otherwise every bot and group turn shows the prompt.
      const text = stripThreadPrefix(textField(event.data, "message") ?? "");
      const last = next.messages[next.messages.length - 1];
      if (last?.role === "user" && last.text === text) return next;
      next.messages.push({
        role: "user",
        text,
        id: id ?? `u-${next.messages.length}`,
      });
      next.pending = true;
      return next;
    }
    case "message.appended": {
      const delta = textField(event.data, "messageDelta") ?? "";
      if (!delta) return next;
      if (!next.blockOpen || !next.currentAssistantId) {
        const mid = id ?? `a-${next.messages.length}`;
        next.currentAssistantId = mid;
        next.blockOpen = true;
        next.messages.push({ role: "assistant", text: delta, id: mid });
        return next;
      }
      next.messages = next.messages.map((message) => (
        message.id === next.currentAssistantId
          ? { ...message, text: `${message.text}${delta}` }
          : message
      ));
      return next;
    }
    case "message.completed": {
      const text = textField(event.data, "message");
      if (text === null) {
        next.blockOpen = false;
        return next;
      }
      if (!next.currentAssistantId || !next.blockOpen) {
        const mid = id ?? `a-${next.messages.length}`;
        next.currentAssistantId = mid;
        next.messages.push({ role: "assistant", text, id: mid });
        next.blockOpen = false;
        return next;
      }
      next.messages = next.messages.map((message) => (
        message.id === next.currentAssistantId ? { ...message, text } : message
      ));
      next.blockOpen = false;
      return next;
    }
    case "turn.completed":
    case "session.waiting":
    case "session.completed":
      next.pending = false;
      next.blockOpen = false;
      next.currentAssistantId = null;
      return next;
    case "turn.cancelled":
      next.pending = false;
      next.blockOpen = false;
      next.currentAssistantId = null;
      return next;
    case "turn.failed":
    case "session.failed":
      next.pending = false;
      next.blockOpen = false;
      next.error = "Turn failed";
      return next;
    case "action.result":
    case "action.partial": {
      const chips = parseSearchChips(event.data);
      if (chips.length > 0) next.searchHits = chips;
      return next;
    }
    default:
      return next;
  }
}

export async function consumeEveNdjson(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: EveEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted) {
    onAbort();
    return;
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseEveStreamLine(line);
        if (event) onEvent(event);
      }
    }
    const tail = parseEveStreamLine(buf);
    if (tail) onEvent(tail);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}
