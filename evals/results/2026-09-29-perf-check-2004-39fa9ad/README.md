# Performance check, 2026-09-29 20:04 (39fa9ad)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 027d962b90dc), git 39fa9ade9741, macOS 26.6.2, Apple M1.
Power AC, memory free 51%, load { 1.49 2.28 2.23 }, other work 201% CPU, web production.
Command: `perf/run.sh check`. Took 734 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 572.3 | 594.3 | 500.6 | 508.5 | 312.9 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 302.5 | 314.7 | 271.2 | 274.3 | 138.9 | disk_snapshot | settled |
| cold_launch | 10 | 879.0 | 930.3 | 856.4 | 899.6 | 1.3 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 4256.8 | 4419.4 | 4055.5 | 4217.7 | 3.7 | none | settled |
| cold_no_snapshot_tools | 5 | 1655.9 | 1821.2 | 1478.5 | 1653.5 | 69.7 | none | settled |
| warm_return_replies | 30 | 556.8 | 619.5 | 481.5 | 537.0 | 388.7 | stash_snapshot | settled |
| warm_return_tools | 30 | 292.0 | 334.3 | 265.4 | 312.9 | 134.4 | stash_snapshot | settled |
| warm_switch_short | 10 | 235.4 | 256.8 | 212.0 | 232.2 | 48.5 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (other work over 250% CPU)

- warm 273% (49% AMPLibraryAgent; 35% fairplayd; 33% deleted)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
