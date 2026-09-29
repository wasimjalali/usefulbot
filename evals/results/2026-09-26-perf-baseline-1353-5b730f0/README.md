# Performance baseline, 2026-09-26 13:53 (5b730f0)

App `/Users/devin/repos/useful-bot/macos/dist/Useful Bot.app` (sha256 af29eb41b473), git 5b730f0b8cf4 with uncommitted changes, macOS 26.5.2, Apple M4 Pro (Virtual).
Power AC, memory free 91%, load { 0.77 1.39 1.73 }, other work 15% CPU, web production.
Command: `perf/run.sh baseline`. Took 881 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1078.5 | 1165.8 | 940.9 | 1008.7 | 1055.7 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 210.9 | 229.7 | 175.1 | 191.2 | 75.5 | disk_snapshot | settled |
| cold_launch | 10 | 607.4 | 672.2 | 587.2 | 650.8 | 10.5 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 13366.0 | 16195.6 | 12909.5 | 15698.6 | 16.6 | none | cap, settled |
| cold_no_snapshot_tools | 5 | 2000.7 | 3071.5 | 1754.9 | 2383.7 | 35.4 | none | settled |
| warm_return_replies | 30 | 1580.6 | 3368.7 | 1351.5 | 1910.2 | 2353.4 | stash_snapshot | settled |
| warm_return_tools | 30 | 234.1 | 304.8 | 193.6 | 228.7 | 216.3 | stash_snapshot | settled |
| warm_switch_short | 10 | 189.0 | 554.3 | 154.3 | 523.0 | 36.5 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.
