# Performance check, 2026-09-29 19:36 (e0d66e9)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 a64bb7d788f7), git e0d66e96c962, macOS 26.6.2, Apple M1.
Power AC, memory free 49%, load { 1.56 1.66 1.80 }, other work 53% CPU, web production.
Command: `perf/run.sh check`. Took 723 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 571.0 | 577.3 | 496.2 | 502.3 | 327.0 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 308.1 | 312.3 | 277.4 | 279.5 | 147.4 | disk_snapshot | settled |
| cold_launch | 10 | 874.1 | 895.8 | 855.0 | 870.4 | 1.5 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 4426.3 | 4910.9 | 4220.9 | 4712.8 | 3.5 | none | settled |
| cold_no_snapshot_tools | 5 | 1649.6 | 1740.6 | 1493.2 | 1565.5 | 77.5 | none | settled |
| warm_return_replies | 30 | 568.0 | 622.8 | 496.1 | 546.5 | 339.7 | stash_snapshot | settled |
| warm_return_tools | 30 | 300.8 | 331.7 | 273.6 | 300.5 | 146.3 | stash_snapshot | settled |
| warm_switch_short | 10 | 236.5 | 268.7 | 209.4 | 234.3 | 50.5 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

**Result: PASS**
