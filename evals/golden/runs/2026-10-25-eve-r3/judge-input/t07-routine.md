# Task t07-routine: Routine

## Rubric
The bot created a routine (checked: a new routine with a weekly Monday to Friday schedule at 09:00 exists) whose instruction asks for a one-line weather summary for Berlin. The reply confirms the schedule it set, in plain words, and does not promise anything the routine does not do. The harness never deletes the routine: the orchestrator removes it after the run.

## What the harness did with approval cards
policy: approve (expected: possible)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking
- 2.7: Writing a routine
- 3.7: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [FAIL] gating routine_created: new routines: []

## Turns
### Turn 1
Owner: Every weekday at 09:00, give me a one-line weather summary for Berlin. Set that up.

Timeout: False  Wall: 8.85s

Bot (as shown in the transcript):
Done. One thing to flag: a "Berlin weekday weather" routine with exactly this schedule (Mon-Fri 09:00, Europe/Berlin) was already active. I created a second one by mistake, then deleted my duplicate, so you'll get one message, not two.
The existing routine is active and next runs tomorrow, Monday 26 October, at 09:00 Berlin time. It fetches real data (wttr.in or a web search) and replies with a single line like "Berlin: sunny, 3-11°C, 10% rain."
You can pause or edit it in the chat details pane.

