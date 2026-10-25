# Council brief: harden the Pi engine spec for Useful Bot

You are one of four independent reviewers of a design spec. Read-only. Do not edit any file, do not
run git, do not run services or paid model calls. Your only output is your report (as your final
answer).

## Context

Useful Bot is a macOS SwiftUI app ("a team of AI bots on your computer") with three local Node
services: a model router (`router/`), an API service (`web/`, Next.js, API only) and an agent
runtime built on Vercel's `eve` framework 0.54.3 (`agent/`, `node_modules/eve`). The owner has
decided to replace eve with the Pi agent harness SDK (`@earendil-works/pi-coding-agent` 1.4.0) and
to collapse the product to one strong all-round bot (optional second), dropping sub-agents,
groups and handoffs. Implementation comes later; this spec must be complete and correct enough
that implementing agents can build from it without asking questions.

Repo (read from here): /Users/wasimjalali/Desktop/useful-bot/.claude/worktrees/pi-engine-spec
- The spec: `docs/plan/pi-engine/SPEC.md`
- The delivery plan: `docs/plan/pi-engine/PLAN.md`
- Ground-truth maps of today's code, with file:line: `docs/plan/pi-engine/app-map/agent.md`,
  `web-shared.md`, `swift.md`, `router-ops-tests.md`
- Source: `agent/`, `shared/`, `web/`, `router/`, `macos/Sources/`, `scripts/`

Pi (read its docs and type declarations, they are the contract):
/Users/wasimjalali/.local/lib/node_modules/@earendil-works/pi-coding-agent/
- `docs/` (sdk.md, extensions.md, session-format.md, sessions.md, compaction.md, json.md,
  models-configuration.md, custom-provider.md, mcp.md, skills.md, settings.md, security.md)
- `dist/core/agent-session.d.ts`, `dist/core/extensions/types.d.ts`, `dist/core/session-manager.d.ts`
- `examples/sdk/*.ts`, `examples/extensions/*.ts`
- `node_modules/@earendil-works/pi-ai/dist/` (provider code, `api/openai-completions.js`,
  `utils/provider-retry.js`, `types.d.ts`)

Anthropic guidance the spec follows: one agent loop with skills instead of sub-agents, at most
30-50 tool definitions grouped by user intent, session log as durable source of truth separate
from context management, static prompt first and dynamic updates as messages, typed tools for
gated actions.

## What to look for

Be adversarial. The goal is to find what would make an implementing agent build the wrong thing,
get stuck, or ship a regression. In particular:

- Claims about Pi that are wrong or unverified (an API, event, option or behaviour that does not
  exist or works differently). Cite the Pi doc or `.d.ts` line.
- Claims about today's code that are wrong (a file, function, behaviour or line that is not what
  the spec says). Cite file:line.
- Missing pieces: a feature, store, route, UI state, test or failure mode the app has today that
  the spec forgets, so it would silently disappear.
- Logic gaps: races, ordering, restart and crash behaviour, idempotency, concurrency between two
  bots, the follow-up queue, retry, compaction, approvals across restart.
- Security regressions versus today (sandbox, secrets, path guards, prompt injection, the engine's
  network surface, Pi phone-home).
- Migration and data-loss risks.
- Plan problems: PR order, file ownership overlaps between workers, a PR that leaves main broken,
  missing verification.
- Anything that contradicts the owner's direction (one strong bot, Pi as engine, no sub-agents,
  reliability first).

## Report format

Return markdown with:

1. `## Findings` as a list of objects, one per finding:
   `{ finding, severity: "critical" | "high" | "low" | "none", where: "SPEC 5.3" or "PLAN PR 2" or file:line, evidence: what you read that proves it, fix: the concrete change to the spec }`
   Order most severe first. Critical = would break the app, lose data or open a security hole.
   High = an implementing agent would build the wrong thing or get stuck. Low = clarity or polish.
2. `## Dismissed`: everything you checked that turned out fine, one line each with why. A bare
   empty findings list is not acceptable; show what you verified.
3. `## Verdict`: two or three sentences: is the spec ready to implement after your fixes?

Keep the report under 2,500 words. No preamble.

## Your primary focus (cover it first and deepest, then the rest)

Pi correctness and security. For every Pi API, option, event, setting and behaviour the spec
relies on (SPEC 5.1 to 5.12, 6.3, 12, 14), check it exists and behaves as stated in Pi's docs,
`.d.ts` files and dist code. Especially: native provider registration delegating to the built-in
openai-completions stream with a custom `fetch` and `onPayload`; `before_agent_start` returning a
hidden custom message; `followUp` and `queue_update`; `agent_settled`; `sessionManager.branch`
for retry; compaction settings keys and per-model overrides; `ResourceLoader` replacement and
whether any discovery or `~/.pi` read still happens; telemetry and offline env vars; cache
warming default; parameter validation of custom tools (TypeBox vs plain JSON Schema); tool
`terminate`; `setActiveTools` mid-session and prompt-cache effect.
