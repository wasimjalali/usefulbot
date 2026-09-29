# Performance check, 2026-09-29 19:11 (e1b27bc)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 a1992fcada7e), git e1b27bc04172 with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 53%, load { 1.69 2.41 2.48 }, other work 47% CPU, web production.
Command: `perf/run.sh check --quick`. Took 226 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 2 | 571.8 | 575.6 | 500.6 | 502.1 | 317.9 | disk_snapshot | settled |
| cold_first_open_tools | 2 | 283.6 | 295.6 | 253.3 | 269.4 | 142.2 | disk_snapshot | settled |
| cold_launch | 4 | 893.1 | 906.4 | 866.3 | 886.0 | 1.3 | disk_snapshot | settled |
| cold_no_snapshot_replies | 1 | 4334.8 | 4334.8 | 4135.6 | 4135.6 | 3.5 | none | settled |
| cold_no_snapshot_tools | 1 | 1805.4 | 1805.4 | 1626.7 | 1626.7 | 69.0 | none | settled |
| warm_return_replies | 6 | 582.7 | 613.7 | 506.3 | 538.7 | 318.8 | stash_snapshot | settled |
| warm_return_tools | 6 | 298.5 | 314.3 | 271.4 | 286.8 | 151.0 | stash_snapshot | settled |
| warm_switch_short | 4 | 235.1 | 246.1 | 209.2 | 213.3 | 43.6 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (other work over 250% CPU)

- warm 306% (54% osanalyticshelper; 30% fairplayd; 29% deleted)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
