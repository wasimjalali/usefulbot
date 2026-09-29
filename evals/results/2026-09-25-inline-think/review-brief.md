You are an adversarial code reviewer. Review branch `fix/inline-think-reasoning` (PR #134) of the Useful Bot repo, checked out in the current working directory. Read the files themselves, not only the diff. Do NOT modify, create or delete any file, and do not run git commands that change state. Report only.

## What the change is meant to do

Some models (MiniMax M3 through OpenCode; MiniMax's own OpenAI-style API by default) write their thinking into the answer text as `<think>...</think>` instead of the `reasoning_content` field. The AI SDK's openai-compatible provider (used by the eve agent, agent/agent.ts) only reads `delta.reasoning_content ?? delta.reasoning`, so the thinking reached eve as answer text and the macOS and web apps showed it in chat bubbles.

The fix:
1. `router/src/inline-think.ts` (new): a per-stream splitter that moves a think block (`<think>` or `<thinking>`) that OPENS a message's content into the reasoning field, for any model. Streamed (`splitThinkBlock`, `flushThinkStream`) and non-streamed (`splitThinkCompletion`). Tags split across chunks must be held until clear. A tag further into the answer must stay text.
2. `router/src/index.ts`: wires the splitter into the streaming path after `settleStreamBlock` (tool-finish.ts) and into the non-streaming path; logs `inline_think_learned` once per provider/model.
3. `router/src/upstreams/opencode.ts`: for openai-chat protocol and a provider/model learned to do this, `rewrapThinkHistory` puts each assistant message's `reasoning_content` back into its content inside `<think>` tags (MiniMax's docs ask for thinking to be preserved in content).
4. `shared/inline-think.ts` (new) + `web/app/page.tsx`: web transcript hides a leading think block in stored replies; a reply that was only thinking renders no row.
5. `macos/Sources/UsefulBotCore/EveStream.swift` (`withoutLeadingThink`) + `Transcript.swift` (`merge`): same for the macOS transcript, keeping durable/live pairing on the raw text.
6. Tests: `test/inline-think.test.ts`, `macos/Tests/UsefulBotCoreTests/InlineThinkTests.swift`. Docs: `docs/spec/SPEC.md`.

The diff against main is saved at the saved PR diff (git diff main...HEAD -- . ':(exclude)evals'); read it first, then open the files it touches.

## What to look for

- Security: injection, privilege escalation, data exposure, anything a model's output could use to break the router's stream or the apps.
- Logic: races, wrong conditionals, off-by-one in the tag hold-back, state diverging across chunks/choices, text or thinking lost or duplicated, held text never released (finish reason, `[DONE]`, stream end without either), the fast path in `splitThinkBlock` skipping blocks it should process, ordering with `settleStreamBlock` and usage accounting, the SSE framing of the extra flushed chunk.
- Data integrity: SSE output the AI SDK would reject (schema of the synthetic chunk), `content` set to "" where it matters, `reasoning` vs `reasoning_content` handling, history rewrap producing messages the router's own `validateMessages` or the upstream would reject, learned-model key mismatch between where it is set (index.ts: upstream.providerId/upstream.model) and read (opencode.ts: resolved.providerId/model).
- Error handling: unhandled exceptions from malformed chunks, silent failures.
- UI: Swift/TS helpers diverging from each other; `Transcript.merge` dropping rows or failure marks it should keep, or breaking durable/live de-duplication; rows flickering while a stored reply replays.
- Whether it does what the task asked: keep thinking out of the UI for MiniMax and any other model that writes it inline.

## Scope and time

Keep this pass tight. Never read a whole large file: always pass a line range. Make one tool call at a time; never issue several reads in parallel. Read the diff first, then only these ranges:
- router/src/inline-think.ts (whole, ~290 lines) and shared/inline-think.ts (whole, ~50 lines)
- router/src/index.ts lines 25-40 and 650-800
- router/src/upstreams/opencode.ts lines 140-175
- macos/Sources/UsefulBotCore/EveStream.swift lines 600-630
- macos/Sources/UsefulBotCore/Transcript.swift lines 60-150
- web/app/page.tsx lines 585-700
Do not search the wider codebase. Already verified, skip: Swift `hasPrefix` with a Substring argument compiles; tests pass; providerId/model keys line up; `n` is pinned to 1; assistant array content is rejected by validateMessages. Write your answer as soon as you have read those files.

## Output

Return a JSON array of findings, each `{ "finding": string, "severity": "critical" | "high" | "low" | "none", "file": string, "line": number }`. Then a DISMISSED list: every issue you considered and why it is not a defect. An empty findings array without a DISMISSED list is not an acceptable answer.
