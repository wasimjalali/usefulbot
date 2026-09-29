# Performance baseline, 2026-09-27 19:19 (c450c11)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 59c1994d8251), git c450c118e2c2, macOS 26.6.2, Apple M1.
Power AC, memory free 56%, load { 1.54 1.70 2.14 }, other work 51% CPU, web production.
Command: `perf/run.sh baseline`. Took 808 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1602.5 | 1615.0 | 1393.6 | 1399.9 | 906.0 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 307.0 | 374.8 | 275.8 | 343.9 | 135.2 | disk_snapshot | settled |
| cold_launch | 10 | 863.8 | 884.7 | 840.8 | 859.8 | 1.4 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 5546.5 | 6023.8 | 5101.4 | 5586.6 | 3.8 | none | settled |
| cold_no_snapshot_tools | 5 | 1517.9 | 1791.1 | 1342.9 | 1618.1 | 75.6 | none | settled |
| warm_return_replies | 30 | 1552.9 | 1763.3 | 1356.5 | 1573.5 | 914.6 | stash_snapshot | settled |
| warm_return_tools | 30 | 305.6 | 324.5 | 271.9 | 280.5 | 158.8 | stash_snapshot | settled |
| warm_switch_short | 10 | 250.1 | 272.7 | 220.9 | 237.0 | 55.9 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.
