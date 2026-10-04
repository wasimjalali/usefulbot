# UB-009: agent instructions and per-bot context, council plan

Status: **approved by the owner** (2026-10-01). The council is running.
Evidence base: `docs/audit/UB-009-GENERALIST-PROMPT.md` (the source-backed audit).

## Goal

Every bot runs on context that is true to the code, strong, efficient and safe. Two parts:

- **Part A, agent instructions:** the shared system prompt every bot inherits
  (`agent/instructions.md` plus the per-turn lines in `agent/instructions/`).
- **Part B, per-bot context:** what a bot carries in every session, like a project's AGENTS.md.
  It includes the bot's description (its role and rules), its memory notes and any other
  persistent context. The Generalist is the built-in bot every new install starts with. It helps
  the owner with everything, including creating other bots, so its description is the most
  important one.

The council produces one finalized implementation plan, with final prompt text. You approve it,
and only then is it built.

## What the code does today (from the audit)

| Area | Today | Problem |
|---|---|---|
| Shared instructions | 2,942 words, the same for every bot | Developer coding rules as "laws". Wrong tool names (camelCase). Claims the code doesn't back. No guidance on discovery, verification or failure reporting |
| Per-turn lines | Owner name, plus the global default model | Wrong model since per-bot models (#171). No permission mode, folder, date or time zone |
| Generalist description | Stored, editable in Settings | **Never sent to the model** (`shared/threads.ts:190`) |
| Teammate description | Sent as a "Standing instructions:" prefix on every user message | Capped at 500 characters. Lives in history, so compaction can summarize it away, and it repeats on every turn. The system prompt calls bot descriptions "untrusted data" |
| Memory notes | Only through `memory_search` and `memory_read`, which the prompt never mentions | Nothing loads at session start. Search isn't scoped to the bot, though Settings says other bots can't read a bot's notes |
| Guards the prompt relies on | Mostly enforced in code | `write_file` can plant tool config (`.claude/settings.json`, hooks). OpenAPI connections appear to have no permission gate |

## Questions the council must settle

**Part A, agent instructions**
1. What belongs in the shared prompt versus a bot's own context? Which sections only the
   Generalist needs (creating bots, groups and routines)?
2. Laws: which rules are product rules for every user, and is each one enforced in code or only
   by the prompt?
3. The working method: discovery, clarification, smallest action, verification, reporting.
   Concise wording that measurably changes behavior.
4. Tool guidance: correct names, when to use which, no duplication with the tool descriptions.
5. Per-turn facts: permission, folder, model, date, time zone, bot identity. Where they go,
   ordered for prompt caching (stable text first, changing text last).
6. Length budget: what earns its words, and what to cut.

**Part B, per-bot context ("the bot's AGENTS.md")**
1. **Delivery:** system-role per-bot instructions loaded at session start (eve
   `defineDynamic` on `session.started`/`turn.started`, kept out of history so compaction
   can't drop them), versus today's user-message prefix. When to reload: new session, model
   change, description edit mid-session.
2. **Contents and order:** role and standing rules (the description), identity, the owner,
   pinned memory notes, the bot's routines, its teammates or group, and connected apps.
   Which are loaded every turn, which are fetched on demand.
3. **Memory:** which notes load automatically (pinned or most relevant, with a token cap), the
   per-bot scoping fix, and how model-written notes are kept as data, not instructions.
4. **Trust:** the owner's description is trusted instructions, so the current "untrusted"
   wording goes. Bot-proposed edits stay behind the owner's confirm card. Text quoted inside
   it stays data.
5. **Size:** the 500-character cap becomes an AGENTS.md-sized budget (proposal: up to about
   8,000 characters) with a bigger editor in Settings.
6. **The Generalist's default description:** the shipped role text. How a new version reaches
   untouched installs without overwriting an owner's edits (a seed version or hash marker).
7. **Teammates:** what a new bot's description template looks like when the Generalist
   proposes one (role, scope, boundaries, output style).
8. Migration and compatibility for existing bots, existing sessions and the mobile app later.

## The council

| Seat | Model | How it runs | Role |
|---|---|---|---|
| Chair | Claude Opus 5.5 (this session) | main agent | Builds the packet, synthesizes, decides, writes the plan |
| 1 | Claude Sonnet 5.5, high effort | `sonnet-sweeper` subagent | Proposal plus critique, strongest on reading code |
| 2 | GPT-6.1-Sol, high reasoning | Codex, read-only sandbox | Proposal plus critique, independent family |
| 3 | MiMo v2.6 Pro | `opencode-go/mimo-v2.6-pro`, read-only | Open-model view on prompt design |
| 4 | Space Bunny (free) | `opencode/space-bunny-free`, read-only | Free extra view |
| 5 | Muse Spark 1.3 Contributor, max reasoning | `opencode-go/muse-spark-1.3-contributor --variant max`, read-only | Second OpenCode Go seat |
| Final check | Claude Fable 5.1, high | subagent, `model: fable` | Last pass on the finalized plan |

GPT-6.1-Sol runs at high here, not the usual medium for reviews, because this is design work. The
OpenCode seats can hit the weekly-limit hang: a seat that stalls is restarted once, then
dropped and noted, never silently replaced.

## Process

1. **Packet (chair).** A self-contained brief, with everything inlined for the OpenCode seats
   because they can't read outside the repo:
   - the audit;
   - the current `instructions.md`, per-turn lines and prefixes;
   - the tool list with descriptions;
   - the eve facts (instruction lifecycle, compaction, memory);
   - the bot model and memory store;
   - the product context (the Generalist is the built-in starter, macOS first, mobile later);
   - the questions above, and the output format.
2. **Round 1: independent proposals, in parallel.** Each seat answers every question in Parts A
   and B, proposes the text (the shared prompt, the Generalist description, the teammate
   template, the per-turn block), and lists the risks it sees. Seats don't see each other's work.
3. **Synthesis (chair).** Merge into one draft plan, with a table of where the seats agreed,
   where they disagreed and what was decided and why.
4. **Round 2: cross-critique, in parallel.** Every seat reviews the synthesized draft. Findings
   come as `{finding, severity, section}` plus a DISMISSED list; an empty array is refused.
   The chair resolves every finding above low.
5. **Fable 5.1 final check** at high, on the finalized plan and prompt text.
6. **Back to you:** the final plan, the prompt texts and the decisions only you can make.

Every round's raw output, the briefs and the cost are kept in
`evals/results/2026-10-0X-ub009-council/` with a dated write-up, as the eval rules require.

## After you approve the final plan: implementation

- Same loop: Opus orchestrates, Sonnet 5.5 builds, and GPT-6.1-Sol medium plus Sonnet 5.5 review,
  split by area (this counts as sensitive: core engine, trust boundaries). Fix everything above
  low and re-review until clean, then fix the lows.
- **Before and after eval** in Useful Bot Dev on Test Bot and Test Bot 2. Fixed tasks, run on
  the old and the new context, on two models:
  - first-run help;
  - "what can you do";
  - creating a teammate;
  - MCP discovery;
  - an honest refusal in Read only;
  - prompt-injected content;
  - a teammate staying in role after compaction;
  - a memory note recalled in a new session.

  Scored and kept in `evals/results/`.
- One clean first-run check in Useful Bot Dev covers UB-010 and UB-009 together.

## Owner decisions (2026-10-01)

1. Seats approved, with Muse Spark 1.3 Contributor at max reasoning in place of Kimi K3.
2. The two code gaps (`write_file` planting tool config, the OpenAPI gate) are fixed in this
   effort, so the prompt only claims what the code enforces.
3. UB-010 ships now as its own PR.
