# MiniMax M3 thinking leaked into chat bubbles

Date: 2026-09-25. Branch `fix/inline-think-reasoning`.

## Question

With MiniMax M3 selected, the bot's thinking showed in the chat as plain text
(`<think>Now verify quickly…</think> The new page is ready.`). Other models
fold their thinking into the working row. Is it MiniMax only, why, and does
the fix keep it out of the UI for any model that does the same?

## Diagnosis

`trace-audit.py` over the local eve traces (`.eve/traces/v1`), grouped by the
turn identity line, before the fix:

| Model (connection) | Segments | Raw `<think>` in text | Reasoning parts |
|---|---|---|---|
| Space Bunny Free (OpenCode) | 397 | 0 | 381 |
| DeepSeek V4.1 Flash (OpenCode) | 99 | 0 | 98 |
| GPT-6-Sol (OpenAI) | 65 | 0 | 15 |
| GPT-6-Luna (OpenAI) | 38 | 0 | 6 |
| GLM 5.3 Flash (OpenCode) | 18 | 0 | 17 |
| MiMo V2.6 Pro (OpenCode) | 11 | 0 | 8 |
| **MiniMax M3 (OpenCode)** | **11** | **11** | 7 |
| MiniMax M2.7 (OpenCode) | 6 | 0 | 6 |

Cause: the AI SDK's openai-compatible provider only reads thinking from
`delta.reasoning_content` / `delta.reasoning`. MiniMax's documented default
on the OpenAI-style API is thinking inside `content`, wrapped in
`<think>…</think>` (MiniMax docs, "Native Format"). OpenCode converts it for
M2.7 but passes M3's through, and the router relayed `/chat/completions`
untouched, so eve stored the thinking as answer text. OpenCode's own docs list
MiniMax models on its Anthropic `/messages` endpoint instead; the router sends
every OpenCode model to `/chat/completions`.

## What changed

- Router (`router/src/inline-think.ts`): a think block (`<think>` or
  `<thinking>`) that opens a message's content, from any model, moves to the
  reasoning field, streamed or not. Tags split across chunks are held until
  clear; held text is released on the finish reason, before `[DONE]`, or at
  stream end. A tag further into the answer stays text.
- The router learns which provider and model did this (logged once as
  `inline_think_learned`) and sends that model's history back with its
  reasoning wrapped in `<think>` inside the content, as MiniMax's docs ask.
- macOS (`Transcript.merge`) and web (`page.tsx`): replies stored before the
  fix hide a leading think block; one that was all thinking shows no bubble.

## Runs

Test Bot, MiniMax M3 Max through OpenCode Go, installed app rebuilt from the
branch. Each run recorded the window with `winrec` at 30 fps; every frame was
OCR'd with Apple Vision (`ocr-frames.swift`, raw text in `run*-ocr.txt.gz`).

| Run | Turn | Steps | Reasoning parts | Raw `<think>` in answer | Frames OCR'd | Frames showing thinking |
|---|---|---|---|---|---|---|
| 1 | Three shell calls, thinking before each, then a summary | 4 | 4 | 0 | 1211 | 0 |
| 2 (cold start, router restarted) | Follow-up leaning on run 1's count, one shell call | 2 | 2 | 0 | 1751 | 0 |

The only `think` text OCR found is the model quoting `<think>…</think>` in the
middle of its run 1 answer, which is correct to keep. Run 2 logged
`inline_think_learned provider=opencode-go model=minimax-m3` on its first reply,
and the model carried run 1's figure (17 files) into its answer.

The Generalist chat from the original report now renders the same stored
messages without the tags, and the bubble that held only thinking is gone.

Tests: 21 router and helper cases (`test/inline-think.test.ts`), 4 Swift
cases (`InlineThinkTests.swift`); full suites 739 Node, 431 Swift, all
passing. Cost: two MiniMax M3 turns on the OpenCode Go plan.

## Reviews

Pass 1 ran SWE-2 high (Devin CLI) and an Opus 5.5 agent on the same brief
(`review-brief.md`). Neither found a critical or high issue. SWE-2 hung four
times in print mode: each time right after firing several reads in
parallel, or while writing a long final answer. It finished once the brief
asked for one tool call at a time and line ranges only. Fixed from the lows:
a model is not learned when its stream also carries a native reasoning
field; a run of leading whitespace over 256 characters is released rather
than held; history messages with non-string content are left alone. Raw
verdicts: `review-swe2-high-pass1.txt`, `review-opus-pass1.md`.

Pass 2 on the fix commit (SWE-2 high about 4 minutes with the tight brief,
Opus about 2 minutes): no critical or high. Both found that the non-streamed
path still learned a model that already sends native reasoning; fixed.
Verdicts: `review-swe2-high-pass2.txt`, `review-opus-pass2.md`. Afterwards the
owner set the review loop to SWE-2 plus one Opus 5.5 reviewer (two at most),
with SWE-2 briefs aimed at a diff file and line ranges (global rules and this
repo's CLAUDE.md).

Pass 3: Opus found nothing in the non-streamed fix. SWE-2 medium on the
CLAUDE.md wording found two ambiguities ("two at most", "from both"); both
reworded. Verdict: `review-swe2-medium-pass3.txt`.

## Follow-up: quoted tags (PR #135)

A third live turn on the merged fix asked MiniMax M3 about this very code.
Its thinking quoted `<think>…</think>`, the first quoted close ended the
block, and the rest of the thinking showed in the bubble. PR #135 counts the
same tag in pairs, ends at a close followed by a blank line, holds text after
an undecided close in a stream, ends a complete message at its last close so
a lone quoted opening tag cannot swallow the answer, and keeps a length-cut
reply as thinking. Live rerun of the same prompt shape: the thinking quoted
the tags 7 times open and 5 times close, and all of it stayed in reasoning.

Reviews, split by area under the new loop: SWE-2 high on the scanner and
state machine, Opus on stream-versus-whole parity and the Swift twin. Pass 1
found a high (a lone quoted open followed by a close without a blank line
swallowed the answer, a regression against main) plus parity and CRLF lows;
all fixed. Pass 2: Opus fuzzed 12,965 texts in every release mode with 0
stream-versus-whole mismatches and compiled the Swift twin against the TS
results (5 exotic Unicode differences). Neither pass 2 found a critical or
high. Verdicts: `pr135-review-*.txt`, `pr135-review-opus.md`.

## Left open

- A router restart forgets which models were learned; the first reply after a
  restart relearns, so that one step's history goes back without the wrap.
- Models whose template emits only `</think>` (no opening tag) are not
  detected; none in the traces do.
- Text after an undecided close does not stream until the block resolves
  (up to 16K characters), and each chunk rescans the held text; past the
  cap it is let go as thinking, which can hide an answer after a lone quoted
  open in a very long reply. A quoted close followed by a blank line inside
  the thinking still ends the block.
- Run 2 surfaced a separate scroll bug: the finished reply landed with its
  last line under the composer fade. Tracked on its own.
