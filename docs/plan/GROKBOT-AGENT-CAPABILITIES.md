# Grok Bot agent capabilities (for Useful Bot parity)

Status: 2026-09-13. Sourced from official docs ([Create and manage Bots](https://docs.x.ai/grok-bot/bots), [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration), [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), [Settings](https://docs.x.ai/grok-bot/settings-and-notifications)) plus observed desktop UX and orchestrator tools. Do not invent APIs.

**Goal for Useful Bot:** a personal multi-agent app where bots (and a chief/CEO bot) can create and shape teammates interactively the way Grok Bot does, using Useful Brain tokens and light theme first. Virtual computer is deferred.

Companion UI screenshots: `docs/grokbot-ui-reference/`.

---

## 1. What a “Bot” is

A Bot is a durable teammate with:

| Piece | Role |
|---|---|
| **Identity** | Name, title (short label), description (standing instructions), avatar |
| **Own conversation** | 1:1 transcript with the user |
| **Memory** | Durable facts/preferences that survive chats (not a full replay of history) |
| **Skills** | Reusable how-to recipes (global library; can be enabled per Bot) |
| **Routines** | When to run work (cron or event), owned by one Bot |
| **Tools / connectors** | Plugins, local computer, cloud computer (Useful Bot: local/loopback only for v1) |

Limits (Grok Bot docs): up to **50 Bots + group chats combined** per account; a Bot can own up to **50 routines**.

---

## 2. Interactive capabilities (user and bot)

### 2.1 Create a Bot (interactive onboarding)

**User path**

1. Sidebar **New** or `Cmd/Ctrl+N`.
2. Choose **Create new Bot** (or “Create new agent”).
3. App opens a Bot named something like **New Agent**.
4. User (or another Bot) edits profile: name, title, description, avatar.
5. Conversation starts with a concrete task.

**Observed product behavior (desktop):** a freshly created Bot often opens by asking what the user wants it to be (role, style, boundaries). That is **conversational profile setup**, not only a static form. Useful Bot should support both:

- Form: name / title / description / avatar
- First-turn onboarding: Bot asks clarifying questions, then proposes a profile and applies it after user confirm

**Bot path (orchestrator creates teammate)**

An existing Bot (e.g. CEO) can create a focused Bot when a job needs a long-lived owner. Docs say: ask before creating several if the user wants a small roster. In practice the orchestrator:

1. Chooses name + description (persona / standing rules)
2. Optionally assigns a sidebar **section**
3. Messages the new Bot with a brief
4. Optionally adds it to a **group chat**

Useful Bot build note: expose `createBot({ name, title?, description?, avatar?, sectionId? })` to the model as a tool with confirmation for bulk creates.

### 2.2 Edit profile (name, title, description, avatar)

**User path:** Bot actions → **Edit Profile** / conversation details → Agent settings.

Editable fields (docs + UI):

- Name
- Title (chip / short role label)
- Description (durable instructions; “custom instructions”)
- Avatar (image or default mark / shape+color style)
- Notifications: ping when this Bot finishes or needs input

**Rule of thumb (docs):**

- **Description** = standing rules (“Never send external messages without approval.”)
- **Chat message** = this-task instructions (“Draft follow-ups for these twelve accounts.”)

Useful Bot: same split. Description is system-ish durable prompt; chat is ephemeral task context. Persist profile in local store (`~/.useful-bot/` or SQLite), not only in UI state.

### 2.3 Pin, hide, sections, duplicate, delete, share

From sidebar / context menu (see `docs/grokbot-ui-reference/02-sidebar/03-bot-context-menu.png`):

| Action | Behavior |
|---|---|
| **Pin** | Keeps Bot at top; UI may show a **larger featured card** (CEO in our shots). Unpinned = compact row. |
| **Move to new section** | Creates/assigns sidebar section headers |
| **Mark as unread** | Sidebar unread state |
| **Rename Bot** | Name only |
| **Edit Profile** | Full profile form |
| **Duplicate** | Copy of profile, settings, enabled skills, routines, avatar. **Does not** copy chat history, learned memory, or attachments. New name like “X copy”. |
| **Copy conversation ID** | Debug / support |
| **Hide from sidebar** | Removes from main list; does **not** pause Bot or routines. Restore via “Show hidden chats” → Unhide. |
| **Delete** | Removes profile, conversation, routines. Confirm. Shared computer files are not Bot-isolated (Grok). Useful Bot: delete local bot record + sessions; do not delete unrelated workspace files. |
| **Share** (docs) | Public share link of Bot config (identity, description, skills, routines). Recipient adds a **copy**. No computer/logins/history. Strip secrets before sharing. Useful Bot v1: defer public share or make export file only. |

### 2.4 Group chats

**User path**

1. New → select **2–6 Bots** → Create group chat  
2. Rename group  
3. Kickoff with who owns what  
4. Edit membership later  

**In-group messaging**

- Untargeted message: Bots decide who answers  
- `@Bot` to direct ownership  
- `@everyone` sparingly  
- User can attach files; **Bot→group handoffs are text-only** today (Grok). Images go Bot→Bot DM if inspection is needed  

Useful Bot: `Channel` / group entity with `memberIds` (max 6), posts fan out to members, optional @-routing.

### 2.5 Bot-to-Bot messaging (handoffs)

A Bot can message another Bot asynchronously. Receiver wakes, works, may reply later. User sees the handoff in the transcript.

Use when:

- One Bot owns a source system, another owns the deliverable  
- Specialist review  
- Long-running work without the user midwifing every step  

Useful Bot: `sendToBot(targetId, message)` tool; store as system-visible handoff events in both transcripts (or a shared handoff log). Require user approval before fan-out to many Bots.

### 2.6 Skills

- Skill = reusable how-to (when to use, inputs, steps, validation, output, approvals)  
- Saved from a successful one-off (“Save this as a skill called …”)  
- Or taught by demonstration (browser teach flow; up to 10 minutes; Useful Bot: defer computer teach)  
- Referenced in composer with `/`  
- Plugins marketplace can ship packaged skills  
- Per-Bot enable/disable for private skills  

Useful Bot: skills as markdown recipes in a global library; `/skill-name` injects into the turn; optional “save skill” tool after a good run.

### 2.7 Routines

- Routine = **one Bot** + **when** (schedule in user TZ, or event: Slack/GitHub/etc.) + **what** (prompt / skill)  
- Create by asking the owning Bot in natural language  
- Manage: enable/pause, test run, edit, history, delete (View conversation details → Routines)  
- Background runs can continue while laptop closed (Grok cloud computer). Useful Bot: local launchd/agent wake or deferred until app/daemon is up  
- Design for trust: draft first; approval for send/purchase/delete/publish; no-data / stale-data policy  

Useful Bot: cron table per bot; event listeners when connectors exist; UI list matching `docs/grokbot-ui-reference/03-agent-pane/*`.

### 2.8 Chat affordances

- Attach files/images, paste links  
- `/` skills, `@` bots/groups/routines/connectors  
- Reply in thread; react (ack only; not safety decisions)  
- Redirect or “Stop now” mid-work  
- Cmd+K search across bots, groups, messages, files, routines, actions  

### 2.9 Approvals and safety

Standing boundaries live in **description**. Consequential actions (send, pay, delete, publish, production changes) stop for approval. Auto-review / local-execution settings are account/desktop wide in Grok; map carefully for Useful Bot’s loopback + Keychain model.

---

## 3. Interactive create flow to copy (product UX)

This is the “starts by asking what do you want me to be” experience.

### Desired Useful Bot flow

1. User taps **Create Bot**.
2. System creates a bot record with temporary name `New Bot`, empty description, default avatar.
3. Opens 1:1 chat. Bot’s **first message** (system-seeded, not model-hallucinated identity):

   > What should I own? Give me a job title, standing rules, and anything I must never do without asking.

4. User answers in chat (or fills the side panel form in parallel).
5. Bot proposes a short profile card: name, title, description bullets.
6. User confirms → `updateProfile` persists → Bot greets in role and asks for the first real task.
7. Optional: “Add to section …” / “Invite to group …”.

### Why this matters

Form-only create is cold. Conversational create teaches the user the description-vs-message split and produces better standing instructions.

---

## 4. What an orchestrator Bot should be able to do (tool surface)

Mirror Grok’s CEO-style orchestration for Useful Bot’s chief agent:

| Capability | Tool / API sketch | Confirm with user? |
|---|---|---|
| Create Bot | `createBot({ name, title?, description?, sectionId? })` | Yes if creating more than one, or always for v1 |
| Update profile | `updateBotProfile({ id, name?, title?, description?, avatar? })` | Soft confirm for description overwrites |
| Create group | `createGroup({ name, memberIds[2..6] })` | Yes |
| Update group members | `updateGroup({ id, add[], remove[] })` | Yes |
| Message Bot / group | `sendToBot` / `postToGroup` | Fan-out yes; single specialist often no |
| Create routine | `createRoutine({ botId, schedule\|event, prompt })` | Yes (acts while away) |
| Pause/resume/delete routine | routine controls | Delete yes |
| Save skill | `saveSkill({ name, description, body })` | Optional |
| List bots / sections / routines | read tools | No |

Agents must **not** delete bots/groups without the user; user deletes from UI (Grok pattern).

---

## 5. Suggested Useful Bot data model (minimal)

```text
Bot { id, name, title, description, avatarPath?, sectionId?, pinned, hidden, createdAt }
Group { id, name, memberIds[] }          // 2..6
Section { id, name, order }
Skill { id, name, description, body, enabledBotIds? }
Routine { id, botId, enabled, schedule|trigger, prompt, lastRunAt? }
Message { id, threadId, role, text, handoffFrom?, handoffTo? }
Thread { id, kind: bot|group, botId?|groupId? }
MemoryFact { id, botId, tier, text, createdAt }  // optional phase 2
```

Persist under `~/.useful-bot/` (markdown + SQLite) to match SPEC local-first rules.

---

## 6. Build order for developer agent

Ship in slices; light theme + Useful tokens throughout.

| Slice | Deliverable | Done when |
|---|---|---|
| **A** | Bot CRUD UI + profile form + pinned/compact rows + sections | Create/edit/delete/hide/pin; sections work |
| **B** | Conversational create onboarding (first-turn questions → apply profile) | New Bot asks for role and writes description after confirm |
| **C** | Groups + @ routing + membership edit | 2–6 bots in a room; @ works |
| **D** | `createBot` / `sendToBot` tools for chief Bot | CEO-like Bot can spawn and brief a specialist (with confirm) |
| **E** | Skills library + `/` mention | Save + invoke one skill |
| **F** | Routines UI + cron runner (local) | One weekday routine fires and posts into the Bot chat |
| **G** | Composer Cursor-likes (model/effort/fast/`+`) | Separate PR; see `07-cursor-inspiration/` |
| **Deferred** | Virtual computer, teach-by-demo, public Bot share links, Marketplace depth | Explicitly later |

---

## 7. Prompt snippet for a coding agent

Use after the shell UI PR, or as a follow-up PR:

```text
Implement Useful Bot multi-agent capabilities described in
docs/plan/GROKBOT-AGENT-CAPABILITIES.md (slices A–B first).

Read docs/grokbot-ui-reference/README.md for UI states (pinned vs compact,
sections). Use web/app/globals.css tokens; light theme first; do not copy
Grok dark styling. No virtual computer.

Must include conversational create: new bot asks what it should be, proposes
name/title/description, applies on confirm. Chief bot may createBot only with
user confirmation. Branch feat/multi-bot-capabilities; PR; never main.
```

---

## 8. Sources

- https://docs.x.ai/grok-bot/bots  
- https://docs.x.ai/grok-bot/chat-and-collaboration  
- https://docs.x.ai/grok-bot/skills-routines-and-automations  
- https://docs.x.ai/grok-bot/settings-and-notifications  
- https://docs.x.ai/grok-bot/overview  
- Desktop captures under `docs/grokbot-ui-reference/`  
- Observed orchestrator tools: CreateAgent, UpdateAgent, CreateChannel, UpdateChannel, SendToAgent, routines/skills/memory via durable state  

When docs and UI disagree, prefer live desktop behavior and re-check docs.x.ai.
