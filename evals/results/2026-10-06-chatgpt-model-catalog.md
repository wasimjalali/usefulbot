# Why the ChatGPT sign-in lists fewer models than the plan runs (2026-10-06)

## The question

After 1.1.2 moved ChatGPT to OpenAI's official Sign in with ChatGPT, the owner's model menu showed GPT-6-Astra and three GPT-5.6 models, while ChatGPT itself offers GPT-6.1 Sol, GPT-6 Sol and GPT-6 Luna too. Is it his plan, a bug in Useful Bot, or OpenAI's list? And is there a fix?

## What ran

1. **The raw catalog.** `GET https://api.openai.com/v1/models` with the dev app's stored ChatGPT access token, exactly as OpenAI's models-and-inference page documents. The token was read in memory and never printed. It had expired, so one "pong" turn to Test Bot let the app refresh it the normal way first. Run by Claude Opus 5.5.
2. **Live inference.** One `POST /v1/responses` per model (`store: false`, `stream: true`, "Reply with the single word OK.") on the same token, checking the served model in `response.completed`.
3. **Research.** A Claude Sonnet 5.5 agent (high effort) read OpenAI's developer docs, the Codex source and other open-source apps' issue trackers. Its full write-up is in `2026-10-06-chatgpt-model-catalog/` (raw copies of OpenAI pages stay local, not in git).

## Results

The signed-in account is a personal account (gmail.com), which the owner describes as Plus.

| Model | In `/v1/models` | Visibility | Live turn |
|---|---|---|---|
| gpt-6-astra | yes | list | not run |
| gpt-5.6-sol, gpt-5.6-terra | yes | list | not run |
| gpt-5.6-luna | yes | list | completed, "OK" |
| gpt-reserve, gpt-5.5, codex-auto-review | yes | hide | not run |
| gpt-6.1-sol | **no** | n/a | **completed, "OK", served gpt-6.1-sol (13 in, 5 out tokens)** |
| gpt-6-sol | **no** | n/a | **completed (HTTP 200)** |
| gpt-6-luna | **no** | n/a | **completed, "OK", served gpt-6-luna** |

Cost: four one-word turns on the owner's plan, about 70 tokens in total, plus the research agent's run (Claude subscription).

## Conclusion

The plan runs the three missing models through the official route. Only OpenAI's catalog for third-party apps leaves them out. The same three slugs are reported missing by T3 Code (issue 14321, 2026-09-29), OpenCode (issue 52375) and OpenClaw (issue 162768, 2026-10-01). The likeliest cause is that the catalog is gated by a `client_version` that OpenAI's own Codex client sends and Useful Bot doesn't. That's unproven for `api.openai.com/v1`.

OpenAI's docs support the fix. The models-and-inference page uses `gpt-6.1-sol` in its own example request, and the docs say to "treat [the catalog] as a catalog, not an entitlement check; a successfully completed inference turn verifies access".

## What changed because of it

- The owner decided (2026-10-06) to add the documented GPT-6 models to the ChatGPT list and verify each on first use: a refusal shows the plan message once and drops the model. There are no background probes, and Useful Bot never sends another client's version number.
- Logged as UB-016, to be built with UB-015 in the next session and shipped in 1.1.3.
