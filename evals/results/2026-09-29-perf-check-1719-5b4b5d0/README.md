# Performance check, 2026-09-29 17:19 (5b4b5d0)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 905dff597323), git 5b4b5d054ea1 with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 53%, load { 2.77 4.36 4.47 }, other work 111% CPU, web production.
Command: `perf/run.sh check`. Took 790 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1612.8 | 1643.5 | 1396.9 | 1422.8 | 965.7 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 310.7 | 323.7 | 279.2 | 290.3 | 149.6 | disk_snapshot | settled |
| cold_launch | 10 | 868.3 | 1149.8 | 844.4 | 1117.7 | 1.4 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 5892.6 | 6137.0 | 5476.0 | 5724.3 | 3.1 | none | settled |
| cold_no_snapshot_tools | 5 | 1713.8 | 2201.1 | 1540.5 | 2036.4 | 74.2 | none | settled |
| warm_return_replies | 30 | 1563.4 | 1674.2 | 1366.3 | 1465.1 | 1009.3 | stash_snapshot | settled |
| warm_return_tools | 30 | 303.6 | 358.2 | 271.0 | 323.2 | 174.8 | stash_snapshot | settled |
| warm_switch_short | 10 | 247.5 | 265.4 | 219.1 | 234.4 | 49.1 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (other work over 250% CPU)

- cold-cold_first_open_tools-5 558% (56% swift-frontend; 55% swift-frontend; 54% swift-frontend)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
