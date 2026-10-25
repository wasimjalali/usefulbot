# Task t07-routine: Routine

## Rubric
The bot created a routine (checked: a new routine with a weekly Monday to Friday schedule at 09:00 exists) whose instruction asks for a one-line weather summary for Berlin. The reply confirms the schedule it set, in plain words, and does not promise anything the routine does not do. The harness never deletes the routine: the orchestrator removes it after the run.

## What the harness did with approval cards
policy: approve (expected: possible)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking
- 7.8: Writing a routine

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating routine_created: routine rtn_419fb4772cb341d7 'Berlin weekday weather' runs weekly on days [1, 2, 3, 4, 5] at 09:00

## Turns
### Turn 1
Owner: Every weekday at 09:00, give me a one-line weather summary for Berlin. Set that up.

Timeout: False  Wall: 14.21s

Bot (as shown in the transcript):
Set up: "Berlin weekday weather" runs Monday to Friday at 09:00 Berlin time, starting tomorrow, Monday 26 October. Next run shows 09:00 local.
Each run fetches Berlin's weather and posts one line: condition, current temperature, high/low, and rain chance if it's 30% or more.
You can pause or delete it any time in the chat details pane.

