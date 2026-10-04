You are reviewing PR #178 of the Useful Bot repo (checked out at /Users/wasimjalali/Desktop/useful-bot, branch fix/subagent-progress-and-limits). Read-only: do not edit files.

Context: a macOS app talks to a local web proxy (Next.js, web/app/eve/v1/[...path]/route.ts), which forwards to an eve agent runtime. Every session path is authorised against a durable session -> bot binding (shared/session-bindings.ts). The PR fixes a silent chat stall (see evals/results/2026-10-03-subagent-stall.md) and adds sub-agent progress.

YOUR AREA (security sensitive, own every line of it): the server side of the diff.
- shared/eve-proxy.ts: new parseInputResponses / bodyHasInputResponses / childStreamQuery.
- shared/session-bindings.ts: parentId on bindings, readSessionParent, bindChildSession, sessionCarriesOverFor.
- web/lib/eve-session-auth.ts: authorizeChildStream, streamHasSubagentCall (verifies a child against the parent's stream from eve; cache; scan caps).
- web/app/eve/v1/[...path]/route.ts: inputResponses POST path; GET session/<child>/stream?parent=<id>; refusals for POST/cancel/reset into a child.
- agent/lib/turn-snapshot.ts: boundBotId no longer binds a `channel.kind === "subagent"` session as a root (returns the claim unbound).
- agent/agent.ts: limits.maxInputTokensPerSession false.
- router/src/request-signal.ts and router/src/index.ts: streaming calls capped at 180 s only until headers arrive, then a 15 min backstop.
- Their tests: test/eve-proxy-guard.test.ts, test/channel-auth.test.ts, test/session-binding.test.ts, test/turn-snapshot.test.ts, test/request-signal.test.ts.
The full diff is at /private/tmp/claude-501/-Users-wasimjalali-Desktop-useful-bot/49c45c6d-d8f7-4a28-9b1e-1edf9d19e27f/scratchpad/pr.diff (also `git diff main...HEAD -- <files>`). Read the touched functions in full, not just hunks.

Look for: auth bypass or privilege escalation (can a caller read or write a session of another bot, read an unverified child, POST into a child, smuggle text/files through inputResponses, poison the binding store, make a root look like a child or the reverse, exhaust memory/time via the verification scan or cache), logic errors (races between binding writes, the agent's unbound child vs the proxy's later bindChildSession, cache staleness, AbortSignal/timer leaks or a stream cut early/never), error handling (silent failures, unhandled rejections, leaking internal errors), data integrity (unsafe coercion, nulls into the store), and whether the change does what the PR says.

Output: a JSON array of findings `{ "finding": string, "severity": "critical"|"high"|"medium"|"low", "file": string, "line": number }`, then a DISMISSED list: every candidate you considered and rejected, one line each with why it is not a defect. An empty findings array without a DISMISSED list is not acceptable.
