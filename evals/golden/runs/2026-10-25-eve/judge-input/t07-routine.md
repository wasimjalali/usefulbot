# Task t07-routine: Routine

## Rubric
The bot created a routine (checked: a new routine with a weekly Monday to Friday schedule at 09:00 exists) whose instruction asks for a one-line weather summary for Berlin. The reply confirms the schedule it set, in plain words, and does not promise anything the routine does not do. The harness never deletes the routine: the orchestrator removes it after the run.

## What the harness did with approval cards
policy: approve (expected: possible)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 7.8: Thinking
- 10.9: Writing a routine
- 11.9: Thinking
- 13.9: Writing

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating routine_created: routine rtn_4c66cc73e6cb4449 'Berlin weather, weekday mornings' runs weekly on days [1, 2, 3, 4, 5] at 09:00

## Turns
### Turn 1
Owner: Every weekday at 09:00, give me a one-line weather summary for Berlin. Set that up.

Timeout: False  Wall: 14.88s

Bot (as shown in the transcript):
Each run will search for the current forecast and reply with just the temperature range, conditions, and any rain or wind worth knowing. You can pause or delete it in the chat details pane.
Done. It's set and active: Berlin, one line, weekdays (Mon to

