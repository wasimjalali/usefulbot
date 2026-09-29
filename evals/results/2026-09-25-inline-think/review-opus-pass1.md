# Opus 5.5 review, pass 1 (PR #134, commit 3c6723b)

Read-only general-purpose agent on Opus, same brief as SWE-2. It ran the 19 tests, `tsc --noEmit`, and a fuzz probe: 11 tricky texts, 300 random 1 to 4 character chunkings each, through `settleStreamBlock` then `splitThinkBlock`, released by finish reason, `[DONE]` and end-of-stream flush. 0 mismatches against `splitLeadingThink` on the whole text.

No critical or high findings. Lows:

| # | Finding | Outcome |
|---|---|---|
| 1 | A reply that is only thinking, with no tool call, now reaches eve as an empty step; eve nudges once, then fails the turn with empty-model-response. Same as native-reasoning models. | Listed in the PR |
| 2 | The inline-think flag is learned from one occurrence, even when the stream also carried native reasoning; a native-reasoning model that once opens an answer with `<think>` would get its history rewrapped. | Fixed: not learned when the stream carries a native reasoning field |
| 3 | `rewrapThinkHistory` dropped non-string (array) assistant content. | Fixed: such messages are left as they are |
| 4 | Rewrap also wraps reasoning from other models earlier in the session, and reasoning containing `</think>` breaks the block. | Listed in the PR |
| 5 | Legacy `post` and `handoff` rows and the web rail preview still show stored think text. | Listed in the PR |
| 6 | Until a choice reaches its answer, every block is parsed and re-serialized. | Listed in the PR (performance only) |

It dismissed 22 other candidates with reasons: tag hold-back off-by-one, release paths, synthetic chunk schema and framing, usage double counting, SSE injection, malformed chunks, `reasoning` vs `reasoning_content`, empty content, key alignment, validation, fast path, CRLF, Swift/TS divergence, `Transcript.merge` dedupe and failure marks, web filter order, flicker, internal callers, error payloads, token growth.
