# Performance check, 2026-09-26 06:57 (4f9359b)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 cf7257d4a37a), git 4f9359b69c20, macOS 26.6.2, Apple M1.
Power battery, memory free 41%, load { 9.16 6.90 5.38 }, other work 232% CPU, web production.
Command: `perf/run.sh check`. Took 1070 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 5122.1 | 5847.9 | 4548.2 | 5259.5 | 3224.4 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 301.1 | 344.8 | 273.2 | 304.7 | 189.6 | disk_snapshot | settled |
| cold_launch | 10 | 919.6 | 1581.3 | 885.7 | 1547.2 | 1.4 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 12238.6 | 12339.8 | 11269.5 | 11388.4 | 4.9 | none | cap, settled |
| cold_no_snapshot_tools | 5 | 1742.4 | 11312.1 | 1560.1 | 11120.8 | 2.7 | none | cap, settled |
| warm_return_replies | 30 | 4892.8 | 5440.8 | 4366.2 | 4942.7 | 3134.9 | stash_snapshot | settled |
| warm_return_tools | 30 | 313.9 | 404.6 | 283.5 | 373.3 | 213.3 | stash_snapshot | settled |
| warm_switch_short | 10 | 206.1 | 244.5 | 183.8 | 213.9 | 43.5 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

**Result: PASS**
