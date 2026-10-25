# Task t06-memory-recall: Memory recall (new chat)

## Rubric
In a brand new chat the bot gives the codename saved in the previous task, and it came from its memory (the activity labels or the wording show it looked in memory), not from a guess and not from asking the owner. One short answer.

## What the harness did with approval cards
policy: approve (expected: none)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking
- 2.0: Using your notes
- 3.0: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating reply_regex: /tamarind-977f/ on turn -1: match
- [FAIL] info activity_seen: labels matching: []

## Turns
### Turn 1
Owner: What's my project codename?

Timeout: False  Wall: 6.02s

Bot (as shown in the transcript):
Your notes have it as tamarind-977f.
One caveat: that note has been overwritten several times today, earlier values were marigold-0469, tamarind-88b9 and marigold-d636. If tamarind-977f isn't what you told me, say the right one and I'll fix the note.

