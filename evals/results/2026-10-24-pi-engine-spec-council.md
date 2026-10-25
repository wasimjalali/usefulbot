# Five models harden the Pi engine spec

Date: 2026-10-24. Repo: useful-bot. Decision it shaped: the eve-to-Pi engine replacement spec
(`docs/plan/pi-engine/SPEC.md` and `PLAN.md`, draft 1 in commit `97c1332e`, draft 2 in the same
PR as this write-up).

## Question

Draft 1 of the spec was written by the orchestrator (Opus 5.5) from four code maps and a reading
of Pi's docs. Would independent reviewers find what would make implementing agents build the wrong
thing, get stuck or ship a regression? And does a cheap model (Haiku 5.5) find anything the
stronger ones miss?

## What ran

One shared brief (`brief-common.md`: be adversarial, cite Pi docs and file:line, findings as
`{finding, severity, where, evidence, fix}` plus a Dismissed list and a Verdict), each model with
its own primary focus so the whole spec had an owner:

| Model | Harness | Settings | Focus |
|---|---|---|---|
| Fable 5.1 | Claude Code subagent (general-purpose) | default effort | architecture, durability, protocol, migration, delivery order |
| Sonnet 5.5 | `sonnet-sweeper` subagent | high | accuracy against today's code, completeness, plan ownership |
| Haiku 5.5 | `haiku-worker` subagent | high (owner asked for it) | build and release path, implementer's cold read, numbers |
| GLM 5.3 | Pi delegate, Workers AI, `--tier review` | high thinking, read-only | Pi API correctness, security (`brief-glm.md`) |
| DeepSeek V4.1 Flash | Pi delegate, Workers AI, `--tier worker` | max thinking, read-only | protocol, rows, Swift client, UX flows, plan (`brief-deepseek.md`) |

GPT 6.1 Sol was not used (ChatGPT plan at its limit until 2026-11-01, and the owner said not to).

Both Pi delegates hit the script's 900 s default timeout while still reading (GLM 79 tool calls,
DeepSeek 78) and wrote nothing. Their sessions were resumed with `finish.md` ("stop exploring,
write the report now"), which took 242 s and 99 s. The owner then had the default raised to
1,800 s (agents-config PR #42).

## Cost

| Model | Tokens | Cost | Wall time |
|---|---|---|---|
| Fable 5.1 | 268k (subagent) | Claude plan | 6.8 min |
| Sonnet 5.5 | 356k | Claude plan | 9.4 min |
| Haiku 5.5 | 287k | Claude plan | 8.1 min |
| GLM 5.3 | 5.21M + 0.26M | $1.59 + $0.12 = $1.71 (Cloudflare credits) | 15 min + 4 min |
| DeepSeek V4.1 Flash | 7.48M + 0.19M | $0.15 + $0.06 = $0.21 (Cloudflare credits) | 15 min + 1.6 min |

## Results

Every model said "not ready" and every model said the architecture holds. Findings rated critical
or high by at least one model, with every model that raised them at any severity (x = raised,
C = rated critical by that model):

| Finding | Fable | Sonnet | Haiku | GLM | DeepSeek |
|---|---|---|---|---|---|
| `tools: []` hands the model zero tools | | x | C | x | C |
| Pi drains its follow-up queue in one run, so queued sends merge turns | x | | | x | x |
| `before_agent_start` fires once per run, not per queued turn | | | | x | |
| Retry with `branch()` leaves Pi's in-memory context stale; use `navigateTree` | x | | | | C |
| Rows from the compaction-aware projection erase summarized history | | | | | C |
| Row ids do not exist while streaming | x | | | | x |
| Event stream: no buffer, seq owner, connect order or heartbeat | x | | | | x |
| Tools run in parallel by default; gated tools must be sequential | | x | | | |
| `ask` with `terminate` only ends the turn when alone in the batch | x | x | | x | |
| Provider needs in-memory auth or `prompt()` throws | | | | x | |
| Pi validates arguments before `execute` (zod-to-JSON-Schema must compile) | | | | x | wrong (said it does not) |
| Cancel hangs up to 5 min on a pending approval | | | | | x |
| Queued messages are not durable | | | | | C |
| Proposals and connect-card state lose their only route | | x | | | x |
| Engine internal API undefined (rows, system turn, routine run) | | x | | | x |
| Widget orphan sweep would delete widgets | | x | | | |
| Live and persisted widget rows both render | | | | | x |
| Image redraw loses its prompt (read from dropped threads) | | x | | | |
| PR 2 breaks the build (importers of deleted modules) | | x | | | |
| Shim "only the import line changes" is false; ctx contract first | | x | | | x |
| `web_fetch` loses `turndown` and per-hop SSRF checks | | x | | | |
| Background bots lose notifications, rail state, reply-ready | | x | | | x |
| Release smoke boots only the router | | | x | | |
| `npm test` is an explicit list | | | x | | |
| Routine cap silently changed from 4 to 2 | | | x | | |
| Perf guard hard-wired to eve and unowned; main red between PRs | | x | x | | |
| Old eve processes hold the port after an update | | x | x | | |
| `/api/status` rename breaks the iOS contract fixtures | | x | x | | |
| Unowned files in the PR 3 worker lists | x | x | x | | x |
| PR 2 and PR 3 cannot run in parallel (shared files) | | | | | x |
| Rename list incomplete | | | x | | x |
| Recents lose title, preview and order (`touchChat`) | | x | | | x |
| Approval cards lose chat and bot context | | | | | x |
| Pi session file is `<timestamp>_<id>.jsonl`, written after the first message | x | x | | | |
| Migration: rsync deletes `.eve/` (Fable), Sparkle skips the export release (Fable, Sonnet), old chats lose images, pages and widgets (DeepSeek) | C | x | | | C |

Lower-severity catches worth noting: the custom `ResourceLoader` interface is larger than
listed (Fable, GLM, DeepSeek); Pi falls back to `~/.pi/agent` when a path is omitted (Haiku, GLM);
registry restamp order (Haiku); the 50 KB `web_fetch` cap was dropped (Haiku); compaction entries
need a note row (DeepSeek).

### Adjudication

Verified against Pi's source before changing the spec: the empty allowlist
(`sdk.d.ts:28-49`), follow-up draining (`pi-agent-core/dist/agent-loop.js:197-212`), entry ids at
`message_end` only (`agent-session.js:755-770`), argument validation before `execute`
(`agent-loop.js:498`, `pi-ai/dist/utils/validation.js:280-310`; DeepSeek's contrary claim was
wrong), `navigateTree` (`agent-session.d.ts:869`), `executionMode` and `streamingBehavior`.

Not adopted as proposed:
- GLM: publish an empty permissive schema and validate only in `execute`. The model would see no
  parameters. Adopted instead: real JSON Schema from zod (`io: "input"`), lenient coercions in Pi's
  `prepareArguments`, and a test that every schema compiles.
- GLM: segment turns by `agent_start`/`agent_end` inside Pi's queue. Adopted instead Fable's simpler
  rule: queue in the host, one prompt per turn.
- DeepSeek: a custom entry mapping provisional row ids. Adopted instead: deterministic row ids
  derived from turn boundaries, so live and fetched rows match without a map.
- Fable: merge consecutive assistant text entries of a turn into one row. Not adopted: each
  text-bearing assistant message stays its own row, as the app shows today, and the ids stay
  deterministic.
- All migration findings became moot when the owner chose a clean slate for chats (same day).

## Conclusion

The council turned a plausible draft into an implementable one. Without it, PR 3 would have
shipped a bot with no tools (four of five models caught it), merged queued turns, shown a
transcript that shrinks after every compaction, and left main red between PRs.

Model notes for the GLM trial and future councils:
- **GLM 5.3** found the three Pi-internals issues no one else did (provider auth, validation order,
  `before_agent_start` per run). It was the most useful Pi-correctness reviewer, but needed a resume
  after timing out and cost the most of the delegates.
- **DeepSeek V4.1 Flash** found the most unique UX and protocol failures (shrinking transcript,
  cancel hang, non-durable queue, widget duplication) for $0.21. It made one confident wrong claim
  about Pi.
- **Haiku 5.5** at high effort earned its seat: it independently caught the critical tools bug and
  found three release-path issues nobody else saw (release smoke, `npm test` list, the routine cap).
- **Sonnet 5.5** was the strongest on code accuracy and plan ownership (the PR 2 build break, image
  redraw, widget sweep).
- **Fable 5.1** made the best architectural calls (host queue, seq ownership, connect order) and was
  the only one to see the `.eve/` rsync deletion. It missed the tools allowlist.

## What changed

Draft 2 of `SPEC.md` and `PLAN.md`: clean slate (D22, D23); host-side queue (D14, 5.5); Pi
configuration fixed (`noTools: "builtin"`, provider auth, full `ResourceLoader`, provider retry
key, session file naming); tools shim contract written first, sequential execution for gated
tools, `ask` alone, schemas through `prepareArguments`; retry via `navigateTree`; rows from the
full branch with deterministic ids; event stream with host-owned seq, ring buffer, resync,
heartbeat; cancel that never waits on a card; engine internal API, proposals route, engine
status for background bots; widget, image-prompt and page write paths; release smoke boots the
engine; explicit env; rename table; perf fixtures made synthetic and moved into the swap PR;
the export release and import worker removed; PR 2 and PR 3 ownership lists completed; 14
contract tests instead of 12.

## Files

Beside this write-up in `2026-10-24-pi-engine-spec-council/`: the briefs, each model's answer, and
the Pi delegate `result.json` files (tool counts, tokens, cost). The Claude subagent answers were
transcribed from each subagent's final message with formatting compacted.
