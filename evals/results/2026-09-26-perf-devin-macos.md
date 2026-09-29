# Perf guard on a clean Devin macOS VM, 2026-09-26

A/B measurement of `fix/empty-bubble-and-stale-approval` (stacked on `fix/landing-mascot-and-guard-lows`, PR #139) against `main` on a fresh macOS cloud machine, following devin-perf-prompt.md.

## Machine

- macOS 26.5.2 (build 25F84), arm64
- Apple M4 Pro (Virtual), 12 cores, 16 GiB (hw.memsize 17179869184)
- VM: `kern.hv_vmm_present=1`, virtual display 1600×1200 (Finder desktop bounds 0,0,1600,1200)
- Node `/usr/local/bin/node` v24.20.0, Xcode 26.6 / Swift 6.3.3, Homebrew 7.0.4, ffmpeg 9.0.1, python3 3.9.6
- Screen & System Audio Recording already allowed for `devin-remote` (the process tree that runs the guard); Lock Screen "turn display off" and "require password" set to Never; `pmset -a sleep 0 displaysleep 0`

## Setup (commands and times, all PDT)

- `ln -s ~/repos/useful-bot ~/Desktop/useful-bot`; checkout `fix/empty-bubble-and-stale-approval` (5b730f0)
- `npm ci` — 3 min, clean (3 audit findings reported, untouched)
- `node scripts/setup-local.mjs` — minted the 5 standard Keychain items
- `security add-generic-password -U -s com.usefulbot.opencode-go -a useful-bot -w "$UB_CLOUD_PROVIDER_KEY"` — the org-wide OpenCode Go key present in this environment is `UB_CLOUD_PROVIDER_KEY`; stored under the service name the services read, never printed
- `npm run build:app` — web + Swift build, ~50 s of compile after the ~70 s Next/yarn prologue (see Problems)
- `node scripts/service.mjs router|web|eve` in background, logs in `~/Library/Logs/UsefulBot/`
- App opened once, OpenCode Go connected via the pasted key, default model set to **DeepSeek V4.1 Flash**, effort **High**

## Fixtures

Built fresh on this machine (`perf/run.sh fixtures`); `Perf Long Tools` was created by hand in the app and set to **Full access** first, per `fixtures.json`'s note — the guard exits before creating it otherwise. `perf/run.sh lock` ran twice; identical session IDs and event counts both times; saved as `~/vm-fixtures.lock.json` (carried across branch checkouts per the brief; copy committed here as `2026-09-26-perf-devin-macos-fixtures.lock.json`).

Lock numbers (this machine's fixtures):

| Bot | events | rows | blocks |
|---|---|---|---|
| Perf Long Tools | 3412 | 32 | 33 |
| Perf Long Replies | 24379 | 26 | 27 |
| Perf Short A | 61 | 6 | 7 |
| Perf Short B | 55 | 6 | 7 |

Fixture build turn times (send → send_done, from the harness marks):

- Perf Short A / B: 3 turns each, 2–3 s per turn.
- Perf Long Tools: 16 turns, 15–34 s each — roughly flat (~13:09–13:16), tool batches bounded by command execution rather than chat length.
- Perf Long Replies: 13 turns, ~13:16–13:44. Turns 1–12 took 76–192 s each (≈2 min, drifting slower as the chat grew); turn 13 (the 1,500-word guide) took 442 s. Slower per turn than the owner's M1 (~35 s × turn number) — the provider round-trip dominates and this VM's path to it is slower.

## A/B results

A = `main` (911164e), B = `fix/empty-bubble-and-stale-approval` (5b730f0). Each run is `perf/run.sh baseline` on a fresh `build:app`, web service restarted after the build. All runs clean: exit 0, "other work" 13–68% CPU (limit 250%).

| Case | Run | Visual med | Visual worst | App med | Stall worst |
|---|---|---|---|---|---|
| warm_return_replies | B1 13:53 | 1580.6 | 3368.7 | 1351.5 | 2353.4 |
| warm_return_replies | A 14:13 | 5431.0 | 6598.5 | 4793.8 | 3375.3 |
| warm_return_replies | B2 14:32 | 1045.5 | 1260.8 | 907.4 | 1027.6 |
| cold_first_open_replies | B1 | 1078.5 | 1165.8 | 940.9 | 1055.7 |
| cold_first_open_replies | A | 5484.9 | 5606.4 | 4835.6 | 3130.8 |
| cold_first_open_replies | B2 | 1067.9 | 1079.6 | 928.6 | 936.9 |
| warm_return_tools | B1 | 234.1 | 304.8 | 193.6 | 216.3 |
| warm_return_tools | A | 206.5 | 234.5 | 174.5 | 73.3 |
| warm_return_tools | B2 | 193.7 | 212.3 | 163.1 | 69.4 |
| warm_switch_short | B1 | 189.0 | 554.3 | 154.3 | 36.5 |
| warm_switch_short | A | 164.8 | 195.7 | 135.7 | 37.3 |
| warm_switch_short | B2 | 160.0 | 187.2 | 134.6 | 61.4 |
| cold_launch | B1 | 607.4 | 672.2 | 587.2 | 10.5 |
| cold_launch | A | 610.4 | 637.5 | 592.0 | 18.9 |
| cold_launch | B2 | 609.0 | 624.5 | 588.9 | 12.1 |
| cold_first_open_tools | B1 | 210.9 | 229.7 | 175.1 | 75.5 |
| cold_first_open_tools | A | 209.8 | 232.9 | 185.6 | 63.4 |
| cold_first_open_tools | B2 | 204.6 | 224.4 | 178.4 | 59.8 |
| cold_no_snapshot_replies | B1 | 13366.0 | 16195.6 | 12909.5 | 16.6 |
| cold_no_snapshot_replies | A | 13280.2 | 13406.7 | 12031.0 | 52.1 |
| cold_no_snapshot_replies | B2 | 13143.9 | 13201.8 | 12706.3 | 11.2 |
| cold_no_snapshot_tools | B1 | 2000.7 | 3071.5 | 1754.9 | 35.4 |
| cold_no_snapshot_tools | A | 1402.0 | 10252.8 | 1228.1 | 11.8 |
| cold_no_snapshot_tools | B2 | 1458.7 | 1468.5 | 1284.5 | 22.1 |

The change under review is unambiguous on this machine: the long markdown chat (Perf Long Replies) returns in ~1.0–1.6 s on the branch vs ~5.4 s on main — about **4.2–5.2× faster** on median. `cold_first_open_replies` improved the same way (~5×). Non-target cases are flat within noise between A and B. `cold_no_snapshot_replies` lands by the 10 s cap on both branches (~13 s) — replay-bound, not render-bound, so it can't see the improvement.

Records: `2026-09-26-perf-baseline-1353-5b730f0` (B1), `…-1413-911164e` (A), `…-1432-5b730f0` (B2).

## Check runs against this machine's own budgets

`perf/budgets.proposed.json` from run B2 was copied into `perf/budgets.json` (kept `_about`, reworded to say these are this VM's). Then:

1. `perf/run.sh check` at 14:47 — **FAIL (exit 1)**. One bad warm iteration out of 30 produced worst-case outliers on the two long-chat cases and one `warm_switch_short` (a 10,584 ms `warm_return_replies` that landed by cap, a 4,846 ms `warm_return_tools`, a 1,055 ms short switch). Medians were all inside budget. Record: `…-perf-check-1447-5b730f0`.
2. `perf/run.sh check` at 15:01 — **FAIL (exit 1)**, broadly. This whole run was machine-slow: `cold_launch` median 835 ms (vs ~605 everywhere else), every case's median and worst breached, several landings hit the cap. Preflight reported "other work 13% CPU" so the guard did not flag the machine busy, but the uniform slowdown (nothing in the diff can slow `cold_launch`) points at a transient host-level slowdown on the shared VM — pmset reported no thermal limit and memory was 90% free. Record: `…-perf-check-1501-5b730f0`.

So the clean check never produced a PASS on this VM: once for isolated outliers, once for a machine-wide slow window. Documented rather than retried past the second failure, per the brief.

3. Injection proof: `Thread.sleep(forTimeInterval: 0.4)` added under `PerfHarness.shared?.mark("select_start", …)` in `AppModel.select(_:)`, rebuilt, `perf/run.sh check` at 15:20 — **FAIL (exit 1)** as required, and in exactly the right way: every select-path case's *median* moved ~+400 ms (`warm_return_tools` 194 → 638, `warm_switch_short` 160 → 578, `warm_return_replies` 1046 → 2028, `cold_first_open_tools` 205 → 642), not just a worst-case blip. The guard distinguishes an injected main-thread block from VM noise. Record: `…-perf-check-1520-5b730f0`. Injection reverted (`git checkout -- macos/`) and the app rebuilt clean; `screenshot-perf-*.png` were taken from that build.

## Problems and workarounds

- `OPENCODE_GO_KEY` is not provisioned as a Devin secret; the org-wide `UB_CLOUD_PROVIDER_KEY` is the OpenCode Go key and was used instead (confirmed by the provider connecting and the fixture turns running).
- Services exit on `credential_store_locked_or_missing` until the keychain item exists — expected; resolved by adding it before first service start (one router start failed first, recorded in `service-router.log`).
- `npm run build:app` invokes Next's TypeScript auto-install, which runs **yarn** and writes a `yarn.lock` (gitignored) plus an optional-dependency `node-liblzma` node-gyp failure (`pkg-config` missing) that is safely ignored. `package-lock.json` sha256 verified identical to HEAD after every build — no drift.
- The guard's fixtures run exits before creating `Perf Long Tools` unless the bot already exists at Full access: created it via New Bot, set the composer permission menu to Full access, re-ran. `Perf Long Replies` needs no permission so the harness created it itself.
- Two clean `check` FAILs on this VM's own budgets (above): VM noise — worst-case outliers once, then a broad slow window. No product-code workaround attempted; the failures are the finding.
- Desktop screenshot tooling: `screencapture -l <id>` with the window id resolved through `CGWindowListCopyWindowInfo` via `swift -e` (pyobjc not installed).

## Verdict

PR #139 makes the long markdown chat faster on this machine too: warm return to Perf Long Replies is ~1.0–1.6 s vs ~5.4 s on main (≈4–5×), matching the claimed ~1.6 s on the owner's M1 — and the guard does catch an injected 400 ms main-thread block here (uniform +400 ms medians, FAIL), though on this shared VM its worst-case budgets also trip on occasional host-level hiccups without any injection.
