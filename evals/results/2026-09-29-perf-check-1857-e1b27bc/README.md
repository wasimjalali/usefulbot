# Performance check, 2026-09-29 18:57 (e1b27bc)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 5dde8124c03c), git e1b27bc04172 with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 50%, load { 3.21 2.77 2.56 }, other work 27% CPU, web production.
Command: `perf/run.sh check --quick`. Took 230 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 2 | 391.7 | 394.2 | 334.0 | 336.9 | 134.5 | disk_snapshot | settled |
| cold_first_open_tools | 2 | 287.0 | 287.4 | 259.0 | 260.3 | 137.0 | disk_snapshot | settled |
| cold_launch | 4 | 899.8 | 914.0 | 875.3 | 884.5 | 1.4 | disk_snapshot | settled |
| cold_no_snapshot_replies | 1 | 13050.7 | 13050.7 | 12860.6 | 12860.6 | 1.3 | none | cap |
| cold_no_snapshot_tools | 1 | 1786.8 | 1786.8 | 1607.4 | 1607.4 | 75.3 | none | settled |
| warm_return_replies | 6 | 368.3 | 389.0 | 314.0 | 334.8 | 164.7 | stash_snapshot | settled |
| warm_return_tools | 6 | 296.9 | 308.0 | 267.1 | 276.5 | 136.6 | stash_snapshot | settled |
| warm_switch_short | 4 | 236.2 | 243.4 | 206.2 | 209.4 | 39.8 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_no_snapshot_replies: visual_ms median 13050.7 > 6680.0
- cold_no_snapshot_replies: visual_ms worst 13050.7 > 10020.0
- cold_no_snapshot_replies: app_ms median 12860.6 > 6140.0
- cold_no_snapshot_replies: app_ms worst 12860.6 > 9210.0
- cold_no_snapshot_replies: landing ended by cap

## Machine busy during the run (other work over 250% CPU)

- prep 280% (93% transparencyd; 28% dasd; 23% contactsd)
- cold-cold_first_open_tools-1 330% (64% dasd; 51% transparencyd; 31% ControlCenter)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
