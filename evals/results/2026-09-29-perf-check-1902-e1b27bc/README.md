# Performance check, 2026-09-29 19:02 (e1b27bc)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 d65020a21088), git e1b27bc04172 with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 50%, load { 2.90 2.72 2.56 }, other work 15% CPU, web production.
Command: `perf/run.sh check --quick`. Took 230 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 2 | 394.8 | 398.5 | 342.1 | 347.8 | 196.0 | disk_snapshot | settled |
| cold_first_open_tools | 2 | 324.6 | 336.8 | 291.1 | 301.2 | 145.4 | disk_snapshot | settled |
| cold_launch | 4 | 869.3 | 887.5 | 841.9 | 869.6 | 1.3 | disk_snapshot | settled |
| cold_no_snapshot_replies | 1 | 13049.7 | 13049.7 | 12860.4 | 12860.4 | 5.0 | none | cap |
| cold_no_snapshot_tools | 1 | 1704.0 | 1704.0 | 1531.5 | 1531.5 | 66.1 | none | settled |
| warm_return_replies | 6 | 391.7 | 398.2 | 340.3 | 346.6 | 191.4 | stash_snapshot | settled |
| warm_return_tools | 6 | 299.1 | 323.0 | 269.9 | 293.7 | 145.8 | stash_snapshot | settled |
| warm_switch_short | 4 | 233.1 | 250.6 | 200.1 | 216.3 | 1.3 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_no_snapshot_replies: visual_ms median 13049.7 > 6680.0
- cold_no_snapshot_replies: visual_ms worst 13049.7 > 10020.0
- cold_no_snapshot_replies: app_ms median 12860.4 > 6140.0
- cold_no_snapshot_replies: app_ms worst 12860.4 > 9210.0
- cold_no_snapshot_replies: landing ended by cap

**Result: FAIL**
