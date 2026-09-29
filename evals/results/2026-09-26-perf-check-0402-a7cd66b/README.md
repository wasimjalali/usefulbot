# Performance check, 2026-09-26 04:02 (a7cd66b)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 9f30c2c00375), git a7cd66beb74c with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 31%, load { 5.60 5.80 5.01 }, web production.
Command: `perf/run.sh check --quick`. Took 289 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 2 | 6357.2 | 6448.9 | 5716.7 | 5830.0 | 4543.1 | disk_snapshot |  |
| cold_first_open_tools | 2 | 372.6 | 374.2 | 338.2 | 342.4 | 243.5 | disk_snapshot |  |
| cold_launch | 6 | 1535.3 | 2840.4 | 1503.6 | 2809.3 | 2.1 | disk_snapshot |  |
| cold_no_snapshot_replies | 1 | 13270.4 | 13270.4 | 12081.4 | 12081.4 | 5.7 | none |  |
| cold_no_snapshot_tools | 1 | 11513.3 | 11513.3 | 11357.0 | 11357.0 | 3.0 | none |  |
| warm_return_replies | 6 | 8318.5 | 9308.0 | 7340.2 | 8418.2 | 5782.0 | stash_snapshot |  |
| warm_return_tools | 6 | 349.6 | 371.5 | 313.1 | 334.8 | 234.0 | stash_snapshot |  |
| warm_switch_short | 4 | 238.7 | 250.3 | 206.0 | 221.1 | 30.0 | stash_snapshot |  |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

**Result: PASS**
