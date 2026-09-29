/**
 * Some models write their thinking into the answer as `<think>…</think>`
 * rather than the reasoning field (MiniMax M3 through OpenCode, MiniMax's own
 * API by default). The router splits it out on the way through (see
 * router/src/inline-think.ts); replies stored before that still carry it, and
 * this keeps it out of their bubbles. Only a block that opens the message
 * counts: a tag further in is the answer talking about tags.
 */

export const THINK_TAGS = [
  { open: "<think>", close: "</think>" },
  { open: "<thinking>", close: "</thinking>" },
] as const;

export type ThinkTag = (typeof THINK_TAGS)[number];

/**
 * How the scanned text ends: `stream` means more may follow, `done` that the
 * message is complete, `cut` that it stopped at the length limit.
 */
export type ScanEnd = "stream" | "done" | "cut";

/** Text held after a quoted close before it is let go as thinking. */
export const MAX_HELD_QUOTED = 16384;

type Scan = { closed: true; end: number; after: number } | { closed: false; safe: number; depth: number };

/**
 * Where a think block ends, in the text after its opening tag. A model that
 * thinks about these tags quotes them, so the same tag is counted in pairs:
 * the block ends at the close that brings the count back to zero, or at any
 * close followed by a blank line. A close that leaves the count above zero
 * may be a quoted one or the real end after a lone quoted opening tag; which
 * one only shows later. So a stream holds everything from that close on,
 * and a complete message whose count never returns to zero ends at its last
 * close, so the answer is never swallowed. A message cut at the length limit
 * is all thinking. Unless `ended` is `done` or `cut`, a partial tag at the end
 * is held too; `safe` is where held text starts and `depth` the count there.
 * `passQuoted` lets a stream stop holding after a quoted close.
 */
export function scanThink(text: string, tag: ThinkTag, depth: number, ended: ScanEnd, passQuoted = false): Scan {
  let i = 0;
  let hold: { safe: number; depth: number } | null = null;
  let lastPassed: { end: number; after: number } | null = null;
  const held = (safe: number, count: number): Scan => ({ closed: false, ...(hold ?? { safe, depth: count }) });
  while (i < text.length) {
    if (text.startsWith(tag.close, i)) {
      const after = i + tag.close.length;
      const tail = text.slice(after);
      if (depth <= 1 || tail.startsWith("\n\n") || tail.startsWith("\r\n\r\n")) return { closed: true, end: i, after };
      if (ended === "stream") {
        // Too little yet to tell whether a blank line follows.
        if ("\n\n".startsWith(tail) || "\r\n\r\n".startsWith(tail)) return held(i, depth);
        if (!passQuoted && !hold) hold = { safe: i, depth };
      } else if (!tail.trim()) {
        return { closed: true, end: i, after };
      }
      lastPassed = { end: i, after };
      depth -= 1;
      i = after;
      continue;
    }
    if (text.startsWith(tag.open, i)) {
      depth += 1;
      i += tag.open.length;
      continue;
    }
    if (ended === "stream" && text[i] === "<") {
      const tail = text.slice(i);
      if (tag.open.startsWith(tail) || tag.close.startsWith(tail)) return held(i, depth);
    }
    i += 1;
  }
  if (ended === "done" && lastPassed) return { closed: true, ...lastPassed };
  return held(text.length, depth);
}

/**
 * A whole message that opens with a think block, split in two. The answer
 * loses the blank lines that separated it from the thinking. An unclosed
 * block is all thinking. Null when the message does not open with one.
 */
export function splitLeadingThink(text: string, ended: "done" | "cut" = "done"): { thinking: string; answer: string } | null {
  const trimmed = text.trimStart();
  for (const tag of THINK_TAGS) {
    if (!trimmed.startsWith(tag.open)) continue;
    const body = trimmed.slice(tag.open.length);
    const scan = scanThink(body, tag, 1, ended);
    if (!scan.closed) return { thinking: body, answer: "" };
    return { thinking: body.slice(0, scan.end), answer: body.slice(scan.after).trimStart() };
  }
  return null;
}
