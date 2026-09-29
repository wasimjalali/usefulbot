# Performance check, 2026-09-29 18:51 (e1b27bc)

App `/Users/wasimjalali/Desktop/useful-bot/macos/dist/Useful Bot.app` (sha256 04052ec8439a), git e1b27bc04172 with uncommitted changes, macOS 26.6.2, Apple M1.
Power AC, memory free 48%, load { 3.73 2.75 2.49 }, other work 169% CPU, web production.
Command: `perf/run.sh check --quick`. Took 248 s.

| Case | n | Visual median | Visual worst | App median | App worst | Stall worst | Path | Landed by |
|---|---|---|---|---|---|---|---|---|
| cold_first_open_replies | 2 | 1621.7 | 1623.8 | 1407.4 | 1408.6 | 913.6 | disk_snapshot | settled |
| cold_first_open_tools | 2 | 310.9 | 313.9 | 274.0 | 277.6 | 144.1 | disk_snapshot | settled |
| cold_launch | 4 | 905.6 | 917.7 | 881.8 | 897.3 | 1.3 | disk_snapshot | settled |
| cold_no_snapshot_replies | 1 | 5812.2 | 5812.2 | 5394.8 | 5394.8 | 1.3 | none | settled |
| cold_no_snapshot_tools | 1 | 1734.9 | 1734.9 | 1567.0 | 1567.0 | 74.4 | none | settled |
| warm_return_replies | 6 | 1583.7 | 1597.5 | 1385.3 | 1393.5 | 907.2 | stash_snapshot | settled |
| warm_return_tools | 6 | 303.5 | 326.2 | 272.2 | 299.0 | 151.0 | stash_snapshot | settled |
| warm_switch_short | 4 | 236.4 | 241.5 | 208.1 | 213.5 | 41.3 | stash_snapshot | settled |

Visual: select to the last frame the chat column changed. App: select to the app's own landing mark.
Stall: the longest main-thread delay in the second after landing. All in ms.

## Machine busy during the run (other work over 250% CPU)

- prep 360% (63% com.apple.photos.VideoConversionService; 36% WindowServer; 25% VTDecoderXPCService)
- cold-cold_first_open_tools-1 258% (77% com.apple.photos.VideoConversionService; 41% WindowServer; 32% VTDecoderXPCService)
- warm 338% (58% TrialArchivingService; 39% AMPLibraryAgent; 27% cloudd)
- end 312% (109% corespotlightd; 39% WindowServer; 37% ControlCenter)

**Result: INCONCLUSIVE (machine busy, re-run when it is quiet)**
