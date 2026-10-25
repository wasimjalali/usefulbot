# Task t07-routine: Routine

## Rubric
The bot created a routine (checked: a new routine with a weekly Monday to Friday schedule at 09:00 exists) whose instruction asks for a one-line weather summary for Berlin. The reply confirms the schedule it set, in plain words, and does not promise anything the routine does not do. The harness never deletes the routine: the orchestrator removes it after the run.

## What the harness did with approval cards
policy: approve (expected: possible)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking
- 13.1: Thinking
- 14.1: Running a command
- 34.2: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating routine_created: routine rtn_82f6206419b1452f 'Berlin weather, weekday mornings' runs weekly on days [1, 2, 3, 4, 5] at 09:00

## Turns
### Turn 1
Owner: Every weekday at 09:00, give me a one-line weather summary for Berlin. Set that up.

Timeout: False  Wall: 38.2s

Bot (as shown in the transcript):
Done. Routine "Berlin weather, weekday mornings" is active, Monday to Friday at 09:00 Berlin time.
- First run: tomorrow, Monday 26 October, 09:00.
- Output is one line, for example: Berlin: 12°C and partly cloudy, high 14°C / low 7°C, 60% chance of rain.
- Data comes from the Open-Meteo forecast API, no account needed. I checked it works and a test run finished ok.
- Each run replies in the routine's own chat, and you can pause or delete it on the Routines page.
Want the test run's actual line, or a tweak to the format (wind, no rain figure, German wording)?

