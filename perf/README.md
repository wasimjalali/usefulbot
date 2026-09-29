# Performance regression guard

Fails a change that makes chats slower to open than `budgets.json` allows. It runs on this Mac,
on the build under review, before merge.

```sh
npm run build:app          # the candidate, plus a fresh production web build
pkill -f 'scripts/service.mjs web'; nohup /usr/local/bin/node scripts/service.mjs web \
  >> ~/Library/Logs/UsefulBot/service-web.log 2>&1 &   # serve that build (the preflight checks)
npm run perf:check         # about 20 minutes
perf/run.sh check --quick  # fewer runs, to try the rig; never a merge gate
```

Exit codes: 0 pass, 1 breach or failed launch, 2 preflight refused, 3 inconclusive (other work
used over 250% CPU (about 3 of 8 cores) at some launch; the record still lists any breaches). Only 0 is a pass. The
app, its services and the guard don't count as other work: a no-snapshot replay loads the
machine on its own.

Other work is sampled every ~2 s during each launch, starting once the recorder is ready (the
first ~1 s of a launch is covered by the sample taken just before it). The record's
`externalCpuDuringRun` and the busy check use the busiest sample of each launch (with its top
three programs, named without arguments). That covers the untimed `prep` launch and the long `warm`
launch too, and one sample above the limit makes the whole record INCONCLUSIVE. The app also writes
`replay_first_event`, `replay_done` and `publish_done` marks (harness only); each sample records
them as `*_ms` after the select.

The run quits Useful Bot, launches the candidate (`macos/dist`) about 20 times in the
background, and reopens the installed app at the end. Keep the screen unlocked. It never
takes the pointer or focus.

## Cases

| Case | What is timed |
|---|---|
| `cold_launch` | App launch until the first chat (Perf Short A) has settled |
| `cold_first_open_tools` / `_replies` | First open of a long chat after a cold launch, from its disk snapshot |
| `cold_no_snapshot_tools` / `_replies` | The same with the snapshot deleted, which is the first launch after a build that changed `UsefulBotCore` or `AppModel.swift` |
| `warm_switch_short` | Switching between two short chats |
| `warm_return_tools` / `_replies` | Coming back to a long chat already opened this launch, 30 times each |

Each sample has three numbers, in ms:

- **visual**: select to the last frame where the chat column changed (60 fps, rail, header
  and composer cropped off). This is the one the owner sees.
- **app**: select to the app's own landing mark.
- **stall**: the longest main-thread delay in the second after landing.

A case fails when its median or worst run is over budget. It also fails when any sample
landed by timeout instead of settling, took a different path than the case is about (the
`sources` list), was still changing when the next step began, or ran on a fixture that no
longer matches `fixtures.lock.json`.

## How it measures

The app does the driving. Launched with `-UsefulBotPerfRun <scenario.json>`,
`macos/Sources/UsefulBotApp/PerfHarness.swift` runs the scenario's steps (select, pause,
quit, and for building fixtures create, send and deny) and writes JSON lines with `CLOCK_UPTIME_RAW` times: `select_start` (before the
outgoing chat is stashed), `landed` (with its reason and restore path), `responsive`, and
`prewarm_start`/`_end`. Without that argument none of it runs. It only selects or sends to
bots named "Perf ...".

`tools/perfrec.swift` records the window with ScreenCaptureKit at 60 fps and scores each
frame's change in the chat column, stamped on the same clock. `runner/perfguard.py`
(standard library only) launches, records, lines the two up and judges.

Why not click the rail: an accessibility click lands 2 to 3 s late, and it switches on
SwiftUI's accessibility tree, which inflates the row builds being timed. The design review
behind these choices is `evals/results/2026-09-26-perf-guard-design-consult.md`.

## Fixtures

Four bots, built once by `perf/run.sh fixtures` from the scripted turns in `fixtures.json`,
then frozen:

- **Perf Short A** and **Perf Short B**: three one-line turns each.
- **Perf Long Tools**: 16 turns of a dozen shell calls each, which makes a replay-heavy
  history. It runs at Full access, set once in the app, so no command waits on a card.
- **Perf Long Replies**: 12 long markdown answers with tables and code, then a
  1,500-word one as the newest turn, which makes a render-heavy history.

`fixtures.json` notes how each one was actually built, including what went wrong.

`perf/run.sh lock` records each fixture's session and event count in `fixtures.lock.json`.
Never send to these bots by hand. If a fixture has to change, rebuild it, re-lock, re-baseline
and say so in the PR.

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
with the change it measured. The raw frames stay in `perf/.runs/`, which is too big to commit.

## Limits

- Cold means the app is cold. The services outlive the app, so they're warm in every case.
- One machine's numbers. Budgets from another Mac don't transfer; re-baseline there.
- Idle CPU and memory aren't guarded yet.
- The no-snapshot cases time the app's 10 s landing cap, not the replay behind it: most launches
  land by cap with every row in. A slower replay can't fail them until the harness marks when the
  replay is done.
