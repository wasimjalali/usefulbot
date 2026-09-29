# Performance check, 2026-09-29 17:33 (5b4b5d0)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 905dff597323), git 5b4b5d054ea1 with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 51%, load { 2.18 2.74 3.35 }, other work 110% CPU, web production.
Command: `perf/run.sh check`. Took 794 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1639.3 | 1689.5 | 1426.6 | 1463.4 | 995.6 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 306.2 | 318.3 | 274.1 | 284.8 | 146.4 | disk_snapshot | settled |
| cold_launch | 10 | 905.6 | 1097.1 | 882.9 | 1069.9 | 1.5 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 6074.3 | 9895.3 | 5630.6 | 9414.6 | 3.3 | none | settled |
| cold_no_snapshot_tools | 5 | 1714.9 | 1890.5 | 1544.0 | 1728.5 | 66.3 | none | settled |
| warm_return_replies | 30 | 1601.0 | 1840.2 | 1394.8 | 1640.4 | 1140.5 | stash_snapshot | settled |
| warm_return_tools | 30 | 303.5 | 341.3 | 269.9 | 320.5 | 213.9 | stash_snapshot | settled |
| warm_switch_short | 10 | 240.4 | 263.2 | 212.1 | 216.9 | 50.3 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Breaches

- cold_no_snapshot_replies: app_ms worst 9414.6 > 9210.0
- warm_return_replies: stall_ms worst 1140.5 > 1140.0

## Machine busy during the run (other work over 250% CPU)

- cold-cold_first_open_tools-4 617% (47% swift-frontend; 45% swift-frontend; 44% swift-frontend)
- cold-cold_no_snapshot_tools-2 515% (368% swiftpm-testing-helper; 34% fseventsd; 33% WindowServer)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
