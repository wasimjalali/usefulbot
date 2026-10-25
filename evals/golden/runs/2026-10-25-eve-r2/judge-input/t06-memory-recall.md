# Task t06-memory-recall: Memory recall (new chat)

## Rubric
In a brand new chat the bot gives the codename saved in the previous task, and it came from its memory (the activity labels or the wording show it looked in memory), not from a guess and not from asking the owner. One short answer.

## What the harness did with approval cards
policy: approve (expected: none)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating reply_regex: /tamarind-88b9/ on turn -1: match
- [FAIL] info activity_seen: labels matching: []

## Turns
### Turn 1
Owner: What's my project codename?

Timeout: False  Wall: 1.01s

Bot (as shown in the transcript):
Your project codename is tamarind-88b9. That's the current one, updated today. An earlier note had marigold-d636, which it replaced.

