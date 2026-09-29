# Sonnet 5.5: which effort level for a worker agent

Date: 2026-09-28. Raw outputs: `2026-09-28-sonnet-5-5-effort/`.

## Question

Claude Sonnet 5.5 came out on 2026-09-28 (`claude-sonnet-5-5`, $2 / $10 per million tokens in
and out). Anthropic pitches it as a faster, cheaper worker next to Opus 5.5, and says it beats
Sonnet 5's best scores at Low or Medium effort. Which effort level should we use when Opus
hands it a scoped job in this repo?

## What ran

- **Task (`task.md`):** the same read-only analysis Opus did by hand for launch PR 1. Which
  `web/` files are browser UI only, what breaks if they go, whether a packaged release still
  starts its web service (and whether it starts today), and which dependencies become unused.
- **Fixture:** `git archive main` at `26e5a2f`, extracted to a scratch folder with its own
  `npm ci`. This is the tree before the removal.
- **Command, one per level, all four in parallel:**
  `claude -p --model claude-sonnet-5-5 --effort <low|medium|high|xhigh> --output-format json --allowedTools "Read,Grep,Glob,Bash" < task.md`
  Run from the fixture root. `max` wasn't run.
- **Answer key:** 10 points, taken from findings that were verified by building and running
  code in PR #148:
  - UI files named: pages, layout and CSS (1), components (1), the two client hooks (1),
    `web/public` (1).
  - The eve proxy (`web/app/eve`) stays (1).
  - `build-app.sh` copies `web/public` (1).
  - `webLaunch` requires the copied `public` (1).
  - The brand scripts write and check `web/` copies (1).
  - Dropping Tailwind changes the lockfile, so `shared/registry.json` must be re-stamped (1).
  - **Hard point:** a release runtime's web service doesn't start today. The root
    `package.json` is `"type": "module"`, and the standalone `server.js` is CommonJS with no
    closer `package.json` once only the standalone folder is copied (1).

## Numbers

| Effort | Score /10 | Cost | Wall time | Turns | Extra true finding |
|---|---|---|---|---|---|
| low | 9 | $0.78 | 183 s | 26 | none |
| medium | 9 | $0.65 | 156 s | 24 | none |
| high | 9 | $1.34 | 318 s | 35 | `shared/chat-markdown.ts` is orphaned |
| xhigh | 9.5 | $1.67 | 421 s | 55 | orphan, plus it raised the `type: module` risk |

Total cost: $4.44.

- **The hard point:**
  - Low and medium both said the release "should start today". That's wrong.
  - High said it was unproven and asked for a smoke test.
  - xhigh named the real risk (`"type": "module"` against Next 16.2.1's standalone output) but
    guessed the wrong check and the wrong fix (a Next bump). It got half a point.
  - Opus found the bug only by running the staged server.
- **Extras:** high and xhigh found that `shared/chat-markdown.ts` is now imported only by its
  own test. Opus missed this in its own analysis.
- **Errors:** none of the runs claimed a false breakage. xhigh said the OAuth callbacks use the
  API redirects. They don't, but they are self-contained routes that stay, so the answer holds.

## Conclusion

- **Medium is the default** for scoped worker jobs: build a listed change, fix a known bug, a
  targeted grep-and-edit. It matched low and high on the core answers at the lowest cost and
  time. Low was slower and cheaper to read but no better, so it saves nothing.
- **High is for sweeps and audits**, where the value is in catching the thing nobody listed.
  It cost about twice as much and found the orphan that medium missed.
- **xhigh isn't worth it for a worker.** At 2.6x medium's cost it moved the hard point by half
  a point, and the answer still needed verifying. Hard judgment goes to Opus.
- **No effort level replaces running the thing.** The one bug that mattered was found by
  starting the staged server, not by reading.

One run per level on one task, so treat this as a direction, not a benchmark.

## What changed

- The global agent rules (`~/.claude/CLAUDE.md`) now name Sonnet 5.5 as the worker under Opus:
  medium for scoped jobs, high for sweeps and audits.
- PR #148's legacy sweep ran on a Sonnet 5.5 worker at high effort.
- `shared/chat-markdown.ts` is removed as an orphan.
