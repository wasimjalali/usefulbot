# UB-012: local models report token usage again (2026-10-04)

## Question

On LM Studio and Custom (OpenAI-compatible) providers, the router logged `inputTokens: null` for
every streamed request. The 2026-10-03 evals (`2026-10-03-ub009-local-8b.md`,
`2026-10-03-ub009-compaction.md`) traced it to the request body: nothing asked for
`stream_options.include_usage`, and llama-server, like OpenAI's chat API, only reports usage on a
stream when asked. eve then compacted on its character estimate alone (once, then never again at
29.6k real tokens against a 24,576 threshold), and the Usage pane showed nothing for local models.

Does asking for usage fix all three: the router's count, the count eve compacts on, and the Usage
pane?

## What ran

- **Change:** `router/src/upstreams/opencode.ts` adds `stream_options: {include_usage: true}` to
  streamed `openai-chat` requests for the `lmstudio` and `custom` providers only. A Custom server
  that answers 400 naming `stream_options` gets one retry without it, and that connection and
  model skip the field from then on (memory only). Branch `fix/ub012-local-stream-usage`, commit
  b59ac3b (the live run). Review lows fixed afterwards: a 422 refusal also retries, and a refusal
  is remembered only once the retry works.
- **App:** Useful Bot Dev built from that branch (`npm run build:dev-app`, `install:dev-app`).
- **Model:** Qwen3-4B Q4_K_M (`Qwen/Qwen3-4B-GGUF`, 2.3 GB) on llama.cpp 0.5.0 (build 11146,
  `brew install llama.cpp`), removed after the run:

  ```
  llama-server -hf Qwen/Qwen3-4B-GGUF:Q4_K_M --alias qwen3-4b --ctx-size 40960 \
    -fa on -ctk q8_0 -ctv q8_0 --jinja --host 127.0.0.1 --port 8089
  ```

- **Wiring:** Providers > Connect > LM Studio, server URL `http://127.0.0.1:8089/v1`; Test Bot's
  model set to "Qwen3 4b" on a fresh session. The app doesn't know this model's window, so eve
  uses the 32,768 default and compacts at 75%, 24,576 tokens.
- **Turns:** `2026-10-04-ub012/turns.json`, sent by `2026-10-03-ub009-evals/run-turns.py`: the
  four 17k-character log excerpts from the 2026-10-03 compaction run (P1 to P4), then a short
  question, two more excerpts and two more questions (9 turns). Command:
  `python3 evals/results/2026-10-03-ub009-evals/run-turns.py "Test Bot" turns.json turns.log.jsonl 420`.
- **Machine:** this Mac (16 GB), Useful Bot Dev only. **Cost:** none (local model).

## Results

**Router: 15 of 15 streamed requests reported usage** (`2026-10-04-ub012/router-usage.jsonl`;
the session id is dropped). On 2026-10-03, 35 of 36 were null.

| time | input | cached | output |
|---|---|---|---|
| 14:05:20 | 14,643 | 0 | 261 |
| 14:07:18 | 19,291 | 2,055 | 181 |
| 14:08:22 | 23,949 | 19,291 | 128 |
| 14:11:14 | 24,292 | 10,093 | 201 |
| 14:24:37 | 19,830 | 10,126 | 244 |

(Full table in the raw file. The 5k-token requests are eve's compaction calls; the ~500-token
ones are title or summary calls.)

**eve: provider-based counts and repeated compaction** (`2026-10-04-ub012/eve-compaction.jsonl`).

- On 2026-10-03, the one `compaction.requested` line carried a fractional estimate (26,835.5).
- Today the first one carries 28,485, which matches the router's last reported prompt (23,949)
  plus its output (128) plus an estimate of the new excerpt. So eve now starts from the
  provider's count.
- The chat compacted **6 times** (turns 3 to 8) instead of once. Every time a new excerpt pushed
  the real prompt past the threshold, it compacted again. This is the "second compaction" the
  item asked for.

**Usage pane:** "By model" lists qwen3-4b, lmstudio, 15 requests, 227K tokens. Screenshot:
`ub012-13-usage-by-model.png` (repo root, not committed). Yesterday's 8B run shows there as 1
request, 3,437 tokens: only its one non-streamed call counted.

## Conclusion

Asking for usage fixes all three. The router logs real counts, eve compacts on them, and the
Usage pane shows local models. The retry path for a Custom server that refuses the field is
covered by router tests (`test/local-stream-usage.test.ts`), not live: no local server at hand
rejects it.

## What changed because of it

UB-012 ships in 1.2.0. Side finding, fixed separately: when the Settings pane scrolls, its content
slides under the close button.
