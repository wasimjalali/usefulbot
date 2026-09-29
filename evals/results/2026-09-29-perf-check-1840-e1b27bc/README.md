# Performance check, 2026-09-29 18:40 (e1b27bc)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 e17f9982d938), git e1b27bc04172, macOS 26.6.2, Apple M1.
Power AC, memory free 55%, load { 1.47 2.27 2.25 }, other work 19% CPU, web production.
Command: `perf/run.sh check --quick`. Took 245 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 2 | 1512.9 | 1600.5 | 1310.7 | 1392.9 | 923.4 | disk_snapshot | settled |
| cold_first_open_tools | 2 | 317.0 | 324.9 | 280.3 | 291.0 | 136.7 | disk_snapshot | settled |
| cold_launch | 4 | 870.7 | 915.7 | 844.8 | 884.5 | 1.4 | disk_snapshot | settled |
| cold_no_snapshot_replies | 1 | 5894.5 | 5894.5 | 5477.8 | 5477.8 | 1.3 | none | settled |
| cold_no_snapshot_tools | 1 | 1759.8 | 1759.8 | 1604.7 | 1604.7 | 55.2 | none | settled |
| warm_return_replies | 6 | 1573.6 | 1591.4 | 1370.6 | 1386.0 | 908.2 | stash_snapshot | settled |
| warm_return_tools | 6 | 301.6 | 322.7 | 269.2 | 299.0 | 135.0 | stash_snapshot | settled |
| warm_switch_short | 4 | 232.0 | 235.1 | 203.5 | 214.4 | 40.4 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (other work over 250% CPU)

- prep 279% (37% coreaudiod; 34% WindowServer; 17% tccd)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
