# Performance baseline, 2026-09-26 05:55 (0caa10d)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 cf7257d4a37a), git 0caa10dea2e9 with uncommitted changes, macOS 26.6.2, Apple M1.
Power battery, memory free 36%, load { 4.20 3.45 4.06 }, web production.
Command: `perf/run.sh baseline`. Took 1106 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 5006.7 | 5304.7 | 4475.4 | 4729.3 | 3167.5 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 317.2 | 324.5 | 289.9 | 291.6 | 168.6 | disk_snapshot | settled |
| cold_launch | 10 | 919.5 | 1503.5 | 898.9 | 1487.4 | 1.4 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 12336.8 | 13156.9 | 11371.6 | 12207.6 | 4.8 | none | cap, settled |
| cold_no_snapshot_tools | 5 | 11278.3 | 11484.1 | 11099.0 | 11293.1 | 3.4 | none | cap |
| warm_return_replies | 30 | 4915.6 | 5453.2 | 4387.3 | 4951.7 | 2908.7 | stash_snapshot | settled |
| warm_return_tools | 30 | 310.4 | 346.2 | 281.8 | 317.7 | 172.0 | stash_snapshot | settled |
| warm_switch_short | 10 | 222.2 | 252.7 | 192.7 | 222.7 | 46.1 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (1-minute load over 6.0)

cold-cold_first_open_tools-1 6.5
