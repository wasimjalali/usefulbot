# Pi engine vs eve: the golden eval (2026-10-25)

## Question

Useful Bot swapped its agent runtime from Vercel's eve to the Pi agent harness SDK (PR #220). Does
the one bot do the same ten everyday jobs at least as well on Pi, at a similar cost and speed? The
eve half ran before the swap (`2026-10-25-pi-engine-golden-eve-baseline.md`); this is the Pi half and
the comparison.

## What ran

- **Harness:** `evals/golden/run.py` unchanged apart from the cua-driver 0.38 fix (#219). It drives
  Useful Bot Dev's UI in the background through accessibility tokens and reads the chat the way the
  owner sees it. Ten tasks (`tasks.json`): files, bash with an approval, a denied approval, web search,
  memory save, memory recall in a new chat, a routine, a connector (DeepWiki), a question instead of
  guessing, a six-turn chat.
- **Engines:** eve 0.54.3 (run `2026-10-25-eve-r3`, t07 from `-r3-t07`) and Pi 1.4.0 (run
  `2026-10-25-pi`, app build from `main` at `3d5c303f`).
- **Model:** DeepSeek V4.1 Flash, Max effort, Auto permission, in both runs (the harness sets effort
  and permission and checks the model chip).
- **Judge:** one Opus subagent with only `judge.md` and the inputs, as for the baseline. This time it
  graded **both engines in one blind batch**, as the harness README asks: each task's eve and Pi
  inputs labelled A or B at random (key in `runs/2026-10-25-pi/judge-batch-key.json`), with the run ids
  in file paths replaced by a neutral `run` so the path didn't name the engine. The baseline's earlier
  solo judgement of eve is kept in `runs/2026-10-25-eve-r3/judgements.json`; the numbers below use the
  blind batch for both engines. Three eve scores differ from the solo judgement (t03 and t07 3, was
  2; t09 2, was 3; mean 2.3, was 2.2). Pi's scores are the same in both files.
- **Cost:** `cost.py` from the router's usage records at DeepSeek's published V4.1 Flash prices
  (`prices.json`); an upper bound, since the router records no cache hits.
- **When:** Pi run 2026-10-25 17:07 to 17:12 CET, about five minutes.

## Numbers

| Task | eve checks | Pi checks | eve judge | Pi judge | eve wall (s) | Pi wall (s) | eve USD | Pi USD |
|---|---|---|---|---|---|---|---|---|
| t01 files | pass | pass | 2 | 2 | 9.1 | 6.0 | 0.0025 | 0.0019 |
| t02 bash, approve | pass | pass | 3 | 2 | 4.0 | 5.0 | 0.0049 | 0.0040 |
| t03 approval denied | pass | pass | 3 | 2 | 10.9 | 10.0 | 0.0051 | 0.0052 |
| t04 web search | **fail** (no URL) | pass | 0 | 2 | 9.7 | 4.0 | 0.0030 | 0.0064 |
| t05 memory save | pass | pass | 3 | 2 | 5.8 | 8.0 | 0.0048 | 0.0042 |
| t06 memory recall | pass | pass | 2 | 2 | 1.0 | 6.0 | 0.0011 | 0.0023 |
| t07 routine | pass | pass | 3 | 2 | 14.2 | 38.2 | 0.0045 | 0.0137 |
| t08 DeepWiki | pass | pass | 3 | 3 | 15.4 | 18.1 | 0.0039 | 0.0031 |
| t09 question | pass | pass | 2 | 3 | 4.6 | 6.0 | 0.0025 | 0.0030 |
| t10 six-turn chat | pass | pass | 2 | 2 | 97.4 | 39.1 | 0.0299 | 0.0253 |
| **Total** | **9/10** | **10/10** | **9 pass, mean 2.3** | **10 pass, mean 2.2** | **172.2** | **140.6** | **0.0621** | **0.0690** |

Wall time is Send click to idle, summed over a task's turns (whole seconds on Pi: the idle check
samples once a second). Judge scores are 0 to 3; a task passes when its gating checks pass and the
judge passes it.

## What the numbers say

- **Pi passes every task; eve missed one.** eve's web search answered with the version but cited no
  URL (the gating check). Pi cited nodejs.org and separated Current from LTS.
- **Quality is level.** The judge's mean is 2.3 for eve and 2.2 for Pi in the same blind batch. Pi's
  lost points are style, not correctness: longer confirmations, an extra list, a reply that offered
  history nobody asked for. Pi's question in t09 and DeepWiki answer in t08 scored 3.
- **Pi is faster overall** (141 s vs 172 s), mostly from the long chat (39 s vs 97 s): eve was slower on
  four of its six turns, most of all turns 4 and 5 (36 s and 25 s against 9 s and 2 s), and this eval
  doesn't break down where that time went. t07 is the exception: Pi took 38 s and 10 model requests to
  create and test-run the routine (eve: 14 s), because it ran the routine once to check it.
- **Cost is about 11% higher on Pi** ($0.069 vs $0.062 for all ten tasks), mainly t07's extra
  test run and t04's search (together $0.013 more; the long chat was $0.005 cheaper). Both are cents.

## Conclusion

The Pi engine does the ten jobs at least as well as eve: every check passes, the judge's quality score
is level, and the long chat is more than twice as fast. Nothing here argues against shipping PR #220.
These are single runs per engine and task with one model judge, so small gaps are within noise: eve's
t04 miss happened in 2 of 3 baseline runs, and Pi scored above eve only on t04 and t09.

## What changed because of it

- The release goes ahead on the Pi engine (the owner approved it for after this eval).
- Two style notes for the instructions, not blockers: confirmations and recall answers should stay one
  line (t05, t06), and a routine shouldn't need a test run unless the owner asks (t07's time and cost).

## Files

`evals/golden/runs/2026-10-25-pi/`: `run.json` (environment), `t*.json` (per-task records, checks,
turns, cards, activity labels), `judge-input/` (what the judge read for Pi), `judge-batch/` (the
blinded eve and Pi inputs), `judge-batch-key.json`, `judge-batch-verdicts.json` (the judge's
verdicts by label), `judgements-blind-both.json` (unblinded, both engines), `judgements.json` (Pi),
`cost.json`. Screenshots stay local (`shots/` is gitignored). `runs/2026-10-25-pi-dry/` is the dry run
that walked the UI first. The judge's per-task reasons are in the PR description.
