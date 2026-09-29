# Pre-launch perf fixes: the long markdown chat, 2026-09-29

## Question

Opening "Perf Long Replies" (12 long markdown answers with tables and code, then a 1,500-word
answer) took about 1.3 s to land and then froze the main thread about 900 ms, against about
0.3 s for the tools chat. Three read-only audits proposed causes:

- **A.** The slim first paint's finish (`finishFirstPaint`, 34 ms after landing) mounts the rest
  of the 20,000-character window in one transaction. Proposed: mount it one message a frame.
- **B.** Per-bubble markdown layout is expensive: `Grid` tables probe every cell, and
  `.textSelection(.enabled)` adds cost. Offscreen: 170 ms per 10.5k answer, 83 ms with
  tables as plain `Text`.
- **C.** PR #154's `.fixedSize(horizontal: false, vertical: true)` on the eager transcript stack
  made the no-snapshot replay about 440 ms slower.

Which of these hold in the real app, and what fixes them without regressing behaviour?

## What ran

- Mac: Apple M1, macOS 26.6.2, AC power. Web service in production mode, restarted after each
  `npm run build:app` (Node 24.14.0).
- Every variant: `npm run build:app`, then `perf/run.sh check --quick` (2 cold opens, 1
  no-snapshot open, 6 warm returns per long chat). Final build: full `npm run perf:check`.
- Records, one per run, beside this file: `2026-09-29-perf-check-<HHMM>-<sha>/`. The quick
  runs 1840 to 1911 were built from uncommitted working trees on top of `e1b27bc` (variant A, C
  and the two probes were not saved as patches; only the rejected A patch below was kept, and B
  became `eb0a0ad`).
- The rejected A patch is kept as `2026-09-29-prelaunch-perf-fixes/rejected-incremental-first-paint.patch`.
- Cost: local compute only, about 1.5 hours of the Mac.

## Numbers (Perf Long Replies, ms; quick runs are n = 2 cold, 1 no-snapshot, 6 warm)

**The quick runs are not clean verdicts.** Checked against each record's README:

| Run | Result | Why |
|---|---|---|
| 1840 | INCONCLUSIVE | busy at prep (279%) |
| 1845 | INCONCLUSIVE | busy at prep (257%) |
| 1851 | INCONCLUSIVE | busy at prep (360%), first_open_tools-1 (258%), warm (338%) and end (312%) |
| 1857 | INCONCLUSIVE | busy at prep (280%) and first_open_tools-1 (330%); its no-snapshot open also landed by the cap (12,861 ms), which would otherwise be a FAIL |
| 1902 | FAIL | the no-snapshot replies open landed by the 10 s cap |
| 1911 | INCONCLUSIVE | busy at warm (306%) |
| **1936** | **PASS** | the only clean run; busiest sample of other work 224%, under the 250% limit |

No busy peak fell in a cold-open replies or no-snapshot replies launch (the tools cold open was busy
in 1851 and 1857). The `warm` launch holds the
warm-return cases, replies included, so the 1851 and 1911 warm-return numbers are the least
trustworthy. The numbers below are still read as direction, not as verdicts, and only 1936 backs
a claim.

| Run | Variant | Cold open app | Cold open stall (worst) | Warm return app | Warm return stall (worst) | No-snapshot app |
|---|---|---|---|---|---|---|
| 1840 | Baseline, `e1b27bc` | 1311 | 923 | 1371 | 908 | 5478 |
| 1845 | A: rest of window one message a frame | 1406 | 757 | 1385 | 780 | 5481 |
| 1851 | C: `fixedSize` on the stack removed | 1407 | 914 | 1385 | 907 | 5395 |
| 1857 | Probe: no text selection, tables as plain `Text` | 334 | 135 | 314 | 165 | 12861 (cap) |
| 1902 | Probe: text selection kept, tables as plain `Text` | 342 | 196 | 340 | 191 | 12860 (cap) |
| 1911 | B: tables on a cached `TableLayout` | 501 | 318 | 506 | 319 | 4136 |
| **1936** | **Final full check, `e0d66e9` (B + landing fix), n = 5/5/30** | **496** | **327** | **496** | **340** | **4221** |

Final full check (1936), all cases: **PASS**, no busy samples.

| Case | App median before (1840, n = 2) | App median after (1936, n = 5) | Stall worst before (n = 2) | Stall worst after (n = 5) |
|---|---|---|---|---|
| cold_first_open_replies | 1311 | 496 | 923 | 327 |
| warm_return_replies | 1371 | 496 | 908 | 340 |
| cold_no_snapshot_replies | 5478 | 4221 | 1 | 4 |
| cold_first_open_tools | 280 | 277 | 137 | 147 |
| warm_return_tools | 269 | 274 | 135 | 146 |
| cold_no_snapshot_tools | 1605 | 1493 | 55 | 78 |
| cold_launch | 845 | 855 | 1 | 2 |
| warm_switch_short | 204 | 209 | 40 | 51 |

Visual medians moved the same way: cold open replies 1513 to 571, warm return replies 1574 to 568.

## What we learned

- **A was a symptom, not the cause.** Mounting one message a frame only cut the stall to about
  760 ms: each step re-laid out the whole eager stack, and its markdown, whatever it added. It
  also made the transcript visibly jump on every step (the tools chat's frame sheet in 1845 shows
  the rows shifting; its visual time went from 300 to 1,245 ms). Rejected.
- **C made no difference in the app** (5,478 vs 5,395 ms, one sample each, noise). The
  `fixedSize` stays, since it fixes the bubble truncation bug. The no-snapshot regression since
  `c450c11` is real, not spread: the full records of 2026-09-27 at `c450c11` (2000, 1933, 1946 and
  baseline 1919) have `cold_no_snapshot_replies` app medians of 5,043 to 5,101 ms, while today's
  full runs at `5b4b5d0` (1719, 1733) sit at 5,476 and 5,631 ms, a ~400 to 550 ms slowdown. Variant C
  ruled out `fixedSize` as the cause and the cause was not identified. It is superseded:
  `TableLayout` brought the case to 4,221 ms, below the old ~5.1 s.
- **B is the cause, and it is `Grid`, not text selection.** In the app, tables as plain text
  took the open from 1.3 s to 0.34 s with selection kept; dropping selection too only saved
  another 8 ms. So text selection stays exactly as it was. `Grid` sized every cell by probing it
  at several widths, nested inside the bubble's own probes.
- **The fix:** `TableLayout`, a custom `Layout` that measures each cell once for its line width
  and once per column width, and caches the result per offered width. Same look: columns hug
  their content while the table fits, share the width fairly and wrap once it does not, header
  band even. It gets about 80% of the plain-text gain while keeping real tables.
- **A pre-existing landing bug surfaced.** With layout this fast, the no-snapshot open of the
  replies chat landed by the 10 s cap in both probe runs. Logging the landing loop showed the
  scroll to the `bottom` marker moving nothing, check after check, with the view 2,224 to
  2,580 points above the bottom. It happened on the unchanged branch too (1 of 3 launches). One
  scroll to the newest block unsticks it, and the marker is reached from there: 5 of 5
  debug launches, then 5 of 5 in the full check, settled.

## Verification

- Swift tests: 447 passed.
- Screenshots of the built app, repo root: `prelaunch-perf-replies-newest.png` (newest answer),
  `prelaunch-perf-replies-table.png` (one full table with wrapped cells, rules and header band, and
  the bottom of another, prose flowing under them with no overlap), `prelaunch-perf-replies-select.png`,
  `prelaunch-perf-short-chat.png` (a short chat's earlier bubbles whole after the last reply
  landed: no truncation).
- Text selection: the `.textSelection(.enabled)` modifier is unchanged and table cells are the
  same `Text` views inside it. A background double-click put the insertion point in the text,
  but a background window shows no selection highlight, so a drag-select-and-copy in the
  foreground was not checked by hand.

## What changed

- `eb0a0ad` perf: markdown tables on a cached `TableLayout` instead of `Grid`.
- `e0d66e9` fix: a replayed long chat lands when the bottom-marker scroll stalls.
- Budgets not touched. The replies cases now sit far under theirs (cold open app median 496 vs
  a 1,690 budget); tightening them is a separate reviewed edit.

## Final run and the ship decision

The last full check on the shipped head (39fa9ad, `evals/results/2026-09-29-perf-check-2004-39fa9ad`) had
no breaches and every launch settled. Replies open 501 ms, warm return 482 ms, stall worst 313 ms,
no-snapshot replies 4,056 ms, cold launch 856 ms. It was marked INCONCLUSIVE by one 2-second sample of
273% in the multi-minute `warm` launch (macOS AMPLibraryAgent and fairplayd, not the app). The owner
accepted it for release on 2026-09-29, on the strength of this run's zero breaches and the clean PASS
at 1936 on code that differs only by a 0.5 pt tolerance in the landing check.
