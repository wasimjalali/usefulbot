# Performance baseline, 2026-09-26 04:08 (a7cd66b)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 9f30c2c00375), git a7cd66beb74c with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 40%, load { 4.22 5.23 5.05 }, web production.
Command: `perf/run.sh baseline`. Took 1139 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 6040.6 | 6605.9 | 5400.8 | 5963.2 | 4691.5 | disk_snapshot |  |
| cold_first_open_tools | 5 | 354.4 | 442.2 | 314.4 | 405.5 | 219.1 | disk_snapshot |  |
| cold_launch | 20 | 2350.5 | 6738.7 | 2298.6 | 6652.1 | 51.3 | disk_snapshot |  |
| cold_no_snapshot_replies | 5 | 11987.1 | 29041.2 | 11795.9 | 25963.2 | 14642.1 | none |  |
| cold_no_snapshot_tools | 5 | 8750.4 | 11716.2 | 8484.6 | 11521.3 | 6.8 | none |  |
| warm_return_replies | 30 | 8634.3 | 13194.2 | 7720.8 | 11339.4 | 9835.3 | stash_snapshot |  |
| warm_return_tools | 30 | 342.3 | 911.6 | 305.0 | 839.9 | 739.2 | stash_snapshot |  |
| warm_switch_short | 10 | 609.4 | 903.1 | 548.7 | 833.1 | 125.7 | stash_snapshot |  |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_no_snapshot_tools: cold-cold_no_snapshot_tools-5: landing ended by cap
- cold_no_snapshot_replies: cold-cold_no_snapshot_replies-1: landing ended by cap
- cold_no_snapshot_replies: cold-cold_no_snapshot_replies-2: landing ended by cap
- cold_no_snapshot_replies: cold-cold_no_snapshot_replies-3: landing ended by cap
- cold_no_snapshot_replies: cold-cold_no_snapshot_replies-4: landing ended by cap
- cold_no_snapshot_replies: cold-cold_no_snapshot_replies-5: landing ended by cap
