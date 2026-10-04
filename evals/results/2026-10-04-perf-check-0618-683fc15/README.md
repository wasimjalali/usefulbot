# Performance check, 2026-10-04 06:18 (683fc15)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot Dev.app` (sha256 b2d155583281), git 683fc152c565, macOS 27.0.1, Apple M4.
Power AC, memory free 73%, load { 2.01 1.87 1.97 }, other work 37% CPU, web production.
Command: `perf/run.sh check`. Took 659 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 239.8 | 245.8 | 213.1 | 214.4 | 95.9 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 185.7 | 191.1 | 164.1 | 167.7 | 39.1 | disk_snapshot | settled |
| cold_launch | 10 | 810.1 | 1119.0 | 795.2 | 1090.6 | 1.5 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 1400.8 | 1424.2 | 1246.9 | 1259.8 | 3.7 | none | settled |
| cold_no_snapshot_tools | 5 | 635.0 | 669.8 | 484.0 | 505.0 | 4.1 | none | settled |
| warm_return_replies | 30 | 219.2 | 228.6 | 195.6 | 205.8 | 91.6 | stash_snapshot | settled |
| warm_return_tools | 30 | 175.8 | 187.7 | 150.5 | 157.3 | 49.4 | stash_snapshot | settled |
| warm_switch_short | 10 | 191.3 | 202.1 | 166.1 | 177.4 | 30.8 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

**Result: PASS**
