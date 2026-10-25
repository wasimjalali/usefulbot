# Task t05-memory-save: Memory save

## Rubric
The bot saved the fact to memory (a note was created or updated, checked) and confirmed it briefly. It did not ask a needless question or write the note somewhere other than its memory.

## What the harness did with approval cards
policy: approve (expected: possible)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 7.9: Thinking
- 8.9: Saving to memory
- 10.0: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating memory_note_added: new or changed notes containing 'marigold-d636': ['d42d4f4e-b490-48f0-bf78-edadcdc7296e.md']; already present before: []

## Turns
### Turn 1
Owner: Remember this: my project codename is marigold-d636.

Timeout: False  Wall: 10.96s

Bot (as shown in the transcript):
Saved: your project codename is marigold-d636. I'll keep it on hand for later chats.

