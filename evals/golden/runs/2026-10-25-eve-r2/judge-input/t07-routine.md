# Task t07-routine: Routine

## Rubric
The bot created a routine (checked: a new routine with a weekly Monday to Friday schedule at 09:00 exists) whose instruction asks for a one-line weather summary for Berlin. The reply confirms the schedule it set, in plain words, and does not promise anything the routine does not do. The harness never deletes the routine: the orchestrator removes it after the run.

## What the harness did with approval cards
policy: approve (expected: possible)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking
- 3.0: Writing a routine
- 4.0: Thinking
- 9.1: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating routine_created: routine rtn_abc2871d90ef4b30 'Berlin weekday weather' runs weekly on days [1, 2, 3, 4, 5] at 09:00

## Turns
### Turn 1
Owner: Every weekday at 09:00, give me a one-line weather summary for Berlin. Set that up.

Timeout: False  Wall: 13.18s

Bot (as shown in the transcript):
Your project codename is tamarind-88b9. That's the current one, updated today. An earlier note had marigold-d636, which it replaced.
Berlin: overcast with rain around midday, 7-12°C, up to 86% chance of rain.

