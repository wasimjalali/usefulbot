# Performance regression guard

Fails a change that makes chats slower to open than `budgets.json` allows. It runs on this Mac,
on the build under review, before merge.

It measures the **dev app** ("Useful Bot Dev", bundle id `ai.useful.bot.dev`), which has its own
state (`~/.useful-bot-dev-app`), ports (4419 router, 4420 web, 4421 engine), Keychain items and
logs (`~/Library/Logs/UsefulBotDev`). The daily app and its services are never quit, launched,
signalled or measured, and the run refuses any other bundle id. Quitting the daily app first is
not needed, but its CPU counts as other work while it is busy. The installed daily app should be
a release build (one with a runtime payload): `build:dev-app` refuses when `/Applications/Useful
Bot.app` has none, since that app runs this checkout and the dev build would swap its web build
underneath it.

```sh
npm run build:dev-app      # the candidate: it carries its own runtime (services + production web build)
# Open the dev app once. It copies that runtime to ~/Library/Application Support/Useful Bot Dev/app,
# stops the dev services still running the previous copy and starts new ones from it (the preflight
# checks the installed copy's stamp matches the app's). Wait for its window, then quit it.
open -g "macos/dist/Useful Bot Dev.app"
npm run perf:check         # about 20 minutes
perf/run.sh check --quick  # fewer runs, to try the rig; never a merge gate
```

Never `pkill -f 'scripts/service.mjs web'`: that name matches the daily app's web service too.

**The fixture chats must be written and locked** before a run (see [Fixtures](#fixtures)). If
`perf/fixtures.dev.lock.json` is missing, `npm run perf:check` and `perf/run.sh baseline` stop at
once with `missing perf/fixtures.dev.lock.json` (exit 1) rather than measure against nothing. To
write them: quit the dev app, then run `perf/run.sh fixtures` (it writes the chats and locks them,
no model turns, a few seconds). The limits in `budgets.json` were set on the eve engine; the first
runs on the Pi engine re-baseline them (see the PR that moved the guard).

Exit codes: 0 pass, 1 breach or failed launch, 2 preflight refused, 3 inconclusive (other work
used over 250% CPU (about 3 of 8 cores) at some launch; the record still lists any breaches). Only 0 is a pass. The
app, its services and the guard don't count as other work: opening a long chat loads the
machine on its own.

Other work is sampled every ~2 s during each launch, starting once the recorder is ready (the
first ~1 s of a launch is covered by the sample taken just before it). The record's
`externalCpuDuringRun` and the busy check use the busiest sample of each launch (with its top
three programs, named without arguments). That covers the untimed `prep` launch and the long `warm`
launch too, and one sample above the limit makes the whole record INCONCLUSIVE. The app also writes
`rows_first_paint` and `rows_done` marks (harness only); each sample records them as `*_ms`
after the select.

The run quits Useful Bot Dev, launches the candidate (`macos/dist/Useful Bot Dev.app`) about 20
times in the background, and reopens the installed dev app (`~/Applications`) at the end if it was
running. Keep the screen unlocked. It never takes the pointer or focus.

## Cases

| Case | What is timed |
|---|---|
| `cold_launch` | App launch until the first chat (Perf Short A) has settled |
| `cold_first_open_tools` / `_replies` | First open of a long chat after a cold launch |
| `warm_switch_short` | Switching between two short chats |
| `warm_return_tools` / `_replies` | Coming back to a long chat already opened this launch, 30 times each |

Each sample has these numbers, in ms:

- **visual**: select to the last frame where the chat column changed (60 fps, rail, header
  and composer cropped off). This is the one the owner sees.
- **app**: select to the app's own landing mark.
- **rows first paint** and **rows done**: select to the app's `rows_first_paint` mark (the loaded
  rows are on screen) and to its `rows_done` mark (the row work is finished).
- **stall**: the longest main-thread delay in the second after landing.

A case fails when its median or worst run is over budget. It also fails when any sample
landed by timeout instead of settling, was still changing when the next step began, or ran on a
fixture chat that no longer matches `fixtures.dev.lock.json`.

## How it measures

The app does the driving. Launched with `-UsefulBotPerfRun <scenario.json>`,
`macos/Sources/UsefulBotApp/PerfHarness.swift` runs the scenario's steps (select, pause,
restore, quit) and writes JSON lines with `CLOCK_UPTIME_RAW` times: `step` (just before a fixture
chat is opened, by title), `rows_first_paint`, `rows_done`, `landed` (with its reason) and
`responsive`. Chats are named by id in the marks and by title in the scenario. Without that
argument none of it runs. It only opens chats titled "Perf ...".

`tools/perfrec.swift` records the window with ScreenCaptureKit at 60 fps and scores each
frame's change in the chat column, stamped on the same clock. `runner/perfguard.py`
(standard library only) launches, records, lines the two up and judges.

Why not click the rail: an accessibility click lands 2 to 3 s late, and it switches on
SwiftUI's accessibility tree, which inflates the row builds being timed. The design review
behind these choices is `evals/results/2026-09-26-perf-guard-design-consult.md`.

## Fixtures

Four synthetic chats of the dev stack's one bot (`bot-useful`), written by
`scripts/perf-fixtures.mjs` as Pi session files under
`~/.useful-bot-dev-app/engine/sessions/bot-useful/` and listed in `engine/chats.json` with
`fixture: true`. That flag keeps them out of the sidebar; the harness lists them with
`GET /api/chats?includeFixtures=1` and opens them by title. No model turn runs, so writing them
costs nothing. The content is seeded (the same text every time); entry ids and timestamps come
from Pi, so every rewrite changes the file hashes and has to be locked again.

- **Perf Short A** and **Perf Short B**: three one-line turns each (12 entries).
- **Perf Long Tools**: 125 turns of twelve tool calls and results each (3,500 entries), a
  replay-heavy history.
- **Perf Long Replies**: about 3,750 markdown answers with a table and a code block, the newest a
  1,500-word one (14,996 entries), a render-heavy history.

To write or rewrite them: quit Useful Bot Dev (the script refuses while the engine listens on its
port), then run `perf/run.sh fixtures`. It runs the script with `UB_STACK=dev`,
`UB_STATE_ROOT=~/.useful-bot-dev-app` and `UB_ENGINE_PORT=4421` (the script refuses without the
first two), merges the four chats into `chats.json` without touching your own chats, replaces any
earlier fixture entries and their files, and then runs `perf/run.sh lock`, which records each
chat's id, entry count and the sha256 of its session file in `perf/fixtures.dev.lock.json`. The
check compares the lock before and after a run. Never send to these chats by hand. If a fixture
has to change, rewrite it, re-lock, re-baseline and say so in the PR.

## Budgets

`perf/run.sh baseline` measures and writes `budgets.proposed.json`:

- median limit: baseline median × 1.2 + 20 ms
- worst limit: the larger of worst × 1.25 and median limit × 1.5
- stall limits: median as above; worst from the worst alone (× 1.25). Neither goes under
  150 ms (one GC pause is tens of ms)

Copy in what you accept by hand. A budget only moves by a reviewed edit, never by the tool.

## Records

Every run writes `evals/results/<date>-perf-<check|baseline>-<HHMM>-<sha>/`: a README with the table,
`report.json`, every launch's marks and a frame sheet of the worst sample per case. Commit it
with the change it measured. The raw frames stay in `~/Library/Caches/UsefulBotPerf/runs/` (`UB_PERF_RUNS` overrides it), outside the checkout: the app reads its scenario there, and a file under `~/Desktop` would wait on a Desktop-folder privacy prompt a background launch never shows. The remembered owner selection (`perf/.runs/owner-selection-dev.json`) stays in the checkout: only the runner reads it, never the app.

## Limits

- Cold means the app is cold. The services outlive the app, so they're warm in every case.
- One machine's numbers. Budgets from another Mac don't transfer; re-baseline there.
- Idle CPU and memory aren't guarded yet.
- The fixtures are synthetic: tool results and answers are generated text, not real model output,
  so they size the row work but not every content shape a real chat has.
