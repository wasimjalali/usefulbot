# Golden eval: ten tasks for the one bot

The same ten tasks run twice with the same model: once on the eve engine (baseline, before the
swap) and once on the Pi engine (after PR 3). Pass rate, latency and cost come out side by side.
Spec: `docs/plan/pi-engine/SPEC.md` section 14 "Eval". The owner approves the spend before a run.

The harness drives **Useful Bot Dev's UI** the way the owner does (accessibility tokens through
`~/.local/bin/cua-driver`: click New chat, type, click Send, click Approve or Deny, read the
transcript from the accessibility tree). It knows nothing about eve or Pi, so one script serves both.

## Run it

Useful Bot Dev (`~/Applications/Useful Bot Dev.app`) must be running, quiet and showing a chat
window, with DeepSeek V4.1 Flash picked in the model chip. Nobody else may use it during the run, and
the screen must be unlocked. One run at a time (it is a shared resource, orchestrator only).

```sh
python3 evals/golden/run.py --engine eve --run-id 2026-10-25-eve        # all ten, about 20 to 40 minutes
python3 evals/golden/run.py --engine eve --only t03,t05 --run-id ...    # a subset
python3 evals/golden/run.py --engine eve --dry-run                      # walk the UI, send nothing
# then the judge (below), then
python3 evals/golden/cost.py --run-id 2026-10-25-eve
```

`--engine` is only a label stored in the records. After the Pi swap run it again with
`--engine pi --run-id <date>-pi`.

The run refuses to start (exit 2, with the reason) unless: the target is `Useful Bot Dev.app` and not
the daily app, the screen is unlocked, the app is quiet (no turn running, no open card, empty
composer), the model chip reads a DeepSeek model, and the highest effort the chip offers can be set.
Before each task it sets the permission chip to what the task needs (all ten need **Auto**) and
reads it back from the dev shell store; if it can't, it stops and prints what to set. It sets
effort to the highest the chip offers (Max today) and never changes the model. It touches nothing
else in the app. Each task opens a new empty chat first (the sidebar's New chat button).

### The judge

For each task, give a clean Opus-class model (no user rules, no skills, no tools) the prompt in
`judge.md` plus `runs/<run-id>/judge-input/<task-id>.md`. Save the answers as
`runs/<run-id>/judgements.json`, `{"t01-files": {"pass": true, "score": 3, "why": "..."}, ...}`.
A task passes when the judge passes it **and** its gating checks pass. Judge both engines in one
batch and don't tell the judge which is which.

## What is measured

Per task, in `runs/<run-id>/<task-id>.json` (plus `judge-input/<task-id>.md` and `shots/`):

| Measure | How |
|---|---|
| Pass | deterministic checks (files, memory notes, routines, cards) plus the judge's rubric verdict |
| Latency | wall seconds per turn, from the moment the Send click returned to the moment the turn stopped working (the 3 s idle confirmation is not counted), `first_busy_s` (seconds from Send to the first poll that saw the Stop button, a working row or a card; an upper bound, resolution about 0.3 s, and 0 means work was already visible when the click returned), `prep_s` (typing and the Send click, not counted), and the per-task total |
| Cost | `cost.py`: input and output tokens from the router's usage records for the task's time window, priced from `prices.json` |
| Behaviour | every approval card seen (tool, preview, what the harness clicked), every question card, the working-row labels in time order (which tools it used), the full transcript text, a screenshot at the end of each turn |

`runs/<run-id>/run.json` holds the environment (app version, model and effort read from the app,
harness commit, cua-driver version) and the ids of any routines the run created. Task 7 creates a
routine: **the harness never deletes anything**, so the orchestrator removes that routine after the
run (its id is in `run.json` under `created_routines`).

### Reading the reply

The accessibility tree lists a text value across several lines when it has newlines (a code block, a
bash command in an approval card), and after a streamed turn it can list a bubble's paragraphs out of
screen order or cut short. The harness joins multi-line values, orders the reply by element frames
(a code block, which has no frame, takes the place of its "Copy code" button), renders code blocks as
fenced text, and reads until two reads 1.5 s apart agree. It never navigates to another chat to force
a redraw: on eve that swaps the bot's live session, which wrecked run `2026-10-25-eve-r2` (kept as a
record of that harness bug). `reply_stable` says whether the reads settled. Approval cards keep the whole preview after the tool name.

### Idle detection

A turn is done when, for 3 seconds in a row (at least 3 samples, one per second), the window shows
no Stop button, no working row and no approval card. The working row is matched by its label (the
labels in `TurnActivity` plus `Using ...` forms) on nodes with no text value, so a reply that happens
to begin with "Thinking" is not mistaken for it. A turn that never shows work is declared idle only
after 15 s. Hard limit 360 s per turn: on a timeout the harness records it, presses Stop and skips
the task's remaining turns. An empty or timed-out accessibility walk is retried and never counts as
idle. Approval cards are clicked as soon as they appear (the card's Approve or Deny button, by label),
and a card that isn't expected is clicked the same way and recorded.

## Rules

- **Dev app only.** Never `/Applications/Useful Bot.app`, the daily app with the owner's real bots
  (the harness checks the process path). Never the owner's real accounts or files: tasks work on a
  fresh copy of `fixtures/seed` per task.
- **Background only.** Accessibility token clicks and `type_text`. No `bring_to_front`, no
  foreground delivery, no real pointer, focus or keyboard.
- **Scratch folders live under your home**, default `~/UsefulBotGolden/<run-id>/<task-id>/`, not
  `/private/tmp/...`. With no folder attached, the bot's file tools stop at the owner's home
  (`agent/lib/workspace.ts`: `resolveWorkspacePath` throws `path_escape` for anything outside it), so
  a scratch folder in `/private/tmp` would fail every file task. The harness refuses to reuse a scratch
  folder and never deletes one; the orchestrator removes `~/UsefulBotGolden/<run-id>` when done.
- **No heavy lock needed.** The run starts no server and no browser; the dev app is already up.
- **Never delete results.** `runs/` is kept, failed or odd runs included. Write-up goes in
  `evals/results/<date>-pi-engine-golden.md`, and the model-evals sync runs after it merges.

## Known gaps and traps

- **What the Pi run depends on.** The harness assumes these stay the same after PR 3. Each one fails
  loud if it changes:
  - `shell.json` keeps `selectedBotId` and the bot's `permission` and `model`;
  - memory notes stay under `memory/notes`;
  - routines keep the `kind`/`days`/`time` schedule shape;
  - the router logs `deepseek-flash` under provider `deepseek` (`cost.py`);
  - the accessibility labels the harness reads (`chat-row`, `starter-prompt`, "Needs approval",
    `approval-deny`, "Effort, speed, and model", the Stop button) stay.

  Working-row labels may differ on Pi. The Stop button remains the main busy signal.

- Tasks 5 and 6 use a made-up codename derived from the run id (`{codeword}` in `tasks.json`), so
  recall can only pass on the note task 5 saved, never on older notes in the dev memory store.
- The judge sees reply text and activity labels, not tool arguments. A tool the UI never names
  (Auto-approved, no card, a generic label) shows only through its effect on the checks.
- The working row's accessibility role isn't documented; matching it by label was verified only on an
  idle window. The Stop button is the primary busy signal.
- Prices: see `prices.json` (source URL and date). The router doesn't record cache hits, so input
  is priced at the cache-miss rate (an upper bound).
