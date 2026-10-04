# UB-009 evals: compaction carries the bot's current text (2026-10-03)

## The question

UB-009 plan section 9 asks that after a compaction, the next request carry the bot's current text. Also covered here: a mid-session edit of that text, made after the compaction.

## What ran

- The same session and setup as `2026-10-03-ub009-local-8b.md`:
  - Test Bot on Qwen3-8B via llama-server;
  - the app's window for it was 32,768 tokens (the default, since the server reports none);
  - eve compacts at `thresholdPercent: 0.75`, so 24,576 tokens.
- **Pushing the context up:** after the 12 behaviour turns, four owner messages each pasted a 17,154 to 17,262-character log excerpt (`turns-local8b-push4.json`), followed by a short question.
- **The edit:** in Settings > Instructions > Edit, Test Bot's text changed from "...end every reply with the exact word PINEAPPLE..." to "...MANGO...". The store showed the new text. Then one more turn (`turns-local8b-edit.json`).
- **Evidence** (the committed extract is `2026-10-03-ub009-evals/local8b-extracts.json`: eve's two compaction lines and the MANGO/PINEAPPLE counts before and after the edit):
  - eve's `compaction.requested` and `compaction.completed` lines in `~/Library/Logs/UsefulBotDev/service-eve.log`, from `agent/hooks/compaction-log.ts`;
  - llama-server's per-request context size;
  - the router payload probe dumps.
- **Cost:** $0 (local model).

## Numbers

| Request | Real prompt tokens | eve's count | Event |
|---|---|---|---|
| after P1 | 17,464 | | |
| after P2 | 21,918 | | |
| P3 | | 26,836 (estimate, no provider usage) | `compaction.requested`, reason `threshold`, then `compaction.completed` |
| after compaction | 24,971 | | the app showed "Conversation compacted to fit the model's window" |
| P4 | 29,626 | | no second compaction |
| P5 | 29,648 | | no second compaction |
| E1, after the edit | 29,540 (29,450 of them re-read: the edit changed the system message) | | the system message has MANGO ×1 and PINEAPPLE ×0 |

- Compactions: **1**.
- Replies after the compaction kept the PINEAPPLE rule. The turn after the edit was sent with MANGO in the system message, exactly once, and no stale PINEAPPLE anywhere in the system text.

## What the run found

1. **The bot's text survives compaction and follows an edit on the very next request.** This is the plan's pass condition. The resolver renders the context per turn (`agent/instructions/context.ts`), so compaction can't drop it.
2. **eve keeps the owner's own messages verbatim when it compacts.**
   - All four pasted excerpts were still in the request after compaction, so the prompt only fell from about 26.4k to 25.0k tokens.
   - By P5 it held 29,648 real tokens, over the 24,576 threshold, with no second compaction.
3. **Without provider usage, eve can't tell.**
   - At P3 its character estimate (26,836) was close to the real count (about 26.6k).
   - After the compaction, though, it never compacted again while the real prompt sat at 29.6k, well over 24,576. Either its estimate then ran at least 17% low or it doesn't recompact right away. With no provider-reported count (llama-server reports none because nothing asks for it, see the 8B write-up), nothing corrects it.
   - One more 4.6k-token paste would have put the prompt near 34k: over the 32,768 window the app assumes, though still under this model's real 40,960.
   - Fix proposed in the 8B write-up: request `include_usage` from local `openai-chat` servers.

## Conclusion

Compaction works for the bot's context: the current instructions are on the next request, before and after an edit. The weak spot isn't UB-009's code. It's the token count eve sees for local models, which only the router can supply.
