# UB-009 council packet: agent instructions and per-bot context

You are one seat on a design council for **Useful Bot**, a macOS app (open source, AGPL-3.0)
where an owner runs several AI "bots" on their own Mac. Each bot is a durable teammate with a
name, a description, its own chat, its own model choice (any provider: ChatGPT, Claude,
Gemini, OpenRouter, OpenCode Go, local Ollama or LM Studio models with small context windows),
a permission mode (Read only, Auto, Full access) and an optional attached folder. Agents run on
**eve** (a durable agent framework, docs excerpted below) behind a local model router. The repo
is at the current working directory; you may read any file in it. **Read only: do not edit,
build, run git, launch apps or call models.**

Every install starts with ONE built-in bot, the **Generalist** (id `bot-useful`). It is the
owner's primary assistant: it does general work on the Mac and helps the owner create and run
other bots (teammates), groups and routines. The owner adds teammates for specific jobs
(for example "Mailer: handles my inbox").

## The owner's direction (verbatim intent)

- The shared agent instructions that every bot inherits have many problems (see the audit). Ground
  them in the code and fix them, for the best performance, efficiency and security.
- **A bot's description is like a project's AGENTS.md:** the model must read it at the start of
  each session and after a model change, and it stays in context the whole time. Without that,
  what is the point of a bot? The Generalist's description is its system prompt.
- A bot's **memory notes** are also persistent context, and so is any other information a bot
  needs every time. Decide what belongs there.
- The result must be high quality, efficient (prompt caching, token budget, small local models)
  and secure (permission gates in code stay authoritative; untrusted content is data).
- Two code gaps found by the audit are fixed in this same effort, so the prompt only claims
  what the code enforces: (1) `write_file` can write tool config another program runs later
  (`.claude/settings.json`, `.claude/hooks/*`, `.codex/config.toml`); the shell sandbox denies
  these, `write_file` does not. (2) OpenAPI connections appear to have no Read only / Auto /
  Full gate (`agent/connections/registry.ts`).

## What you must produce

Answer in Markdown with exactly these sections. Be concrete: name files, functions and line
numbers you rely on, and quote the code when a claim depends on it. Say "unverified" when you
infer. Prefer measured effect over length: every sentence of a prompt must change behavior.

### Part A: shared agent instructions (all bots inherit)
- **A1 Split.** What belongs in the shared prompt versus a bot's own context; which sections only
  the Generalist needs (bots, groups, routines, connector setup), and how a teammate avoids
  carrying them.
- **A2 Laws.** The product-level rules for every owner. For each: enforced in code (cite) or
  prompt-only. Remove developer-only rules.
- **A3 Working method.** Discovery, clarification, smallest action, verification, reporting,
  honest limits. Concise wording.
- **A4 Tools.** How tools are referenced (correct snake_case names), what the prompt says versus
  what tool descriptions already say (no duplication), and gaps (memory, web, images,
  sub-agents, PDFs/images/spreadsheets).
- **A5 Per-turn facts.** Which facts the model gets each turn (bot, permission, folder, model,
  date, time zone, ...), where (system versus user role), and ordering for prompt caching
  (stable first, changing last).
- **A6 Budget.** A word budget for the shared prompt and what to cut. Consider small local
  models.
- **A7 Proposed text.** The full proposed shared instructions (replacing `agent/instructions.md`)
  and the per-turn block template.

### Part B: per-bot context ("the bot's AGENTS.md")
- **B1 Delivery.** How the description reaches the model: system-role per-bot instructions via eve
  dynamic instructions (`session.started` / `turn.started`), versus today's user-message prefix
  (`shared/threads.ts:184-229`, `shared/eve-proxy.ts:159-205`). When it reloads (new session,
  model change, description edited mid-session), how it survives compaction, and the effect on
  prompt caching. Check eve's docs below for what a dynamic resolver can read (session id, the
  bot) and cite.
- **B2 Contents and order.** What the per-bot block contains (description, identity, owner, memory
  notes, the bot's routines, its group or teammates, connected apps, ...): always loaded versus
  fetched on demand by a tool.
- **B3 Memory.** Which notes load automatically (pinned? most recent? relevant?), a token cap, the
  per-bot scoping fix (`memory_search`/`memory_read` are not scoped by bot today, see audit),
  how a model-written note is kept as data and not instructions, and whether eve's own memory
  providers (docs below) fit better than the app's `MemoryStore`.
- **B4 Trust.** The owner's description is trusted instructions (today the shared prompt calls bot
  descriptions untrusted). Bot-proposed edits go through the owner's confirm card. Text quoted
  inside a description is still data. Address prompt-injection paths (a page that tells the
  model to propose a description edit, a note that carries instructions).
- **B5 Size and editing.** Replace the 500-character cap (`shared/shell-store.ts:35`) with a
  budget; the Settings editor (macOS) consequences.
- **B6 The Generalist's default description.** Propose the full shipped text. Design how a newer
  shipped version reaches installs where the owner never edited it, without overwriting an
  owner's edit (a seed version or hash marker; the audit lists the three historical seed
  strings).
- **B7 Teammate template.** What the Generalist writes into a new teammate's description when it
  proposes one (role, scope, boundaries, output), as text the Generalist follows.
- **B8 Migration and compatibility.** Existing bots, existing eve sessions, groups (a group's
  orchestrator voice), routines and handoffs (`web/lib/agent-exec.ts`), and a later mobile app.

### Also
- **C Code changes.** A file-by-file list of the changes your design needs, including the two
  security gaps above.
- **D Risks.** What could go wrong and how to detect it (an eval idea for each).
- **E Disagreements.** Anything in the audit you think is wrong, with evidence.

---

# Source material (inlined)
