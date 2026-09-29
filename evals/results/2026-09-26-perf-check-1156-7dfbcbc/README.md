# Performance check, 2026-09-26 11:56 (7dfbcbc)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 52ba60755b64), git 7dfbcbc32e8e, macOS 26.6.2, Apple M1.
Power battery, memory free 43%, load { 9.85 8.82 5.62 }, other work 78% CPU, web production.
Command: `perf/run.sh check`. Took 883 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 5 | 1693.2 | 1739.0 | 1475.3 | 1512.3 | 1033.1 | disk_snapshot | settled |
| cold_first_open_tools | 5 | 323.5 | 332.9 | 283.2 | 307.0 | 173.9 | disk_snapshot | settled |
| cold_launch | 10 | 986.2 | 1537.8 | 955.0 | 1511.6 | 1.9 | disk_snapshot | settled |
| cold_no_snapshot_replies | 5 | 13454.3 | 13676.6 | 13014.0 | 13229.8 | 20.7 | none | cap, settled |
| cold_no_snapshot_tools | 5 | 2067.9 | 2108.7 | 1893.4 | 1952.2 | 63.9 | none | settled |
| warm_return_replies | 30 | 1640.5 | 1732.3 | 1432.5 | 1521.5 | 1072.1 | stash_snapshot | settled |
| warm_return_tools | 30 | 313.8 | 393.1 | 283.2 | 354.6 | 204.7 | stash_snapshot | settled |
| warm_switch_short | 10 | 221.7 | 252.0 | 190.8 | 229.6 | 47.2 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (other work over 250% CPU)

- cold-cold_first_open_replies-4 261% (123% opencode; 33% cua-driver serve --socket /Users/wasimjalali/Library/Caches/; 30% /System/Library/PrivateFrameworks/SkyLight.framework/Resourc)
- cold-cold_no_snapshot_replies-4 259% (134% opencode; 29% /System/Library/PrivateFrameworks/SkyLight.framework/Resourc; 26% cua-driver serve --socket /Users/wasimjalali/Library/Caches/)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
