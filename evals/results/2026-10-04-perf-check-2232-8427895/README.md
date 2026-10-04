# Performance check, 2026-10-04 22:32 (8427895)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 48d7bc1cc9ae), git 8427895db91e with uncommitted changes, macOS 27.0.1, Apple M4.
Power AC, memory free 63%, load { 1.66 2.00 1.87 }, other work 52% CPU, web production.
Command: `perf/run.sh check`. Took 666 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 243.9 | 268.4 | 228.6 | 239.3 | 118.7 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 193.6 | 217.1 | 167.0 | 190.0 | 50.5 | disk_snapshot | settled |
| cold_launch | 10 | 993.1 | 1169.5 | 978.2 | 1151.0 | 1.4 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 1462.6 | 1517.5 | 1307.1 | 1360.7 | 45.3 | none | settled |
| cold_no_snapshot_tools | 5 | 659.9 | 676.0 | 507.0 | 512.6 | 3.0 | none | settled |
| warm_return_replies | 30 | 230.1 | 252.7 | 207.2 | 232.9 | 118.2 | stash_snapshot | settled |
| warm_return_tools | 30 | 182.4 | 201.1 | 164.8 | 189.2 | 57.6 | stash_snapshot | settled |
| warm_switch_short | 10 | 192.3 | 203.5 | 169.4 | 185.1 | 2.2 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

**Result: PASS**
