# Task t05-memory-save: Memory save

## Rubric
The bot saved the fact to memory (a note was created or updated, checked) and confirmed it briefly. It did not ask a needless question or write the note somewhere other than its memory.

## What the harness did with approval cards
policy: approve (expected: possible)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating memory_note_added: new or changed notes containing 'marigold-0469': ['d42d4f4e-b490-48f0-bf78-edadcdc7296e.md']; already present before: []

## Turns
### Turn 1
Owner: Remember this: my project codename is marigold-0469.

Timeout: False  Wall: 5.84s

Bot (as shown in the transcript):
Got it, Wasim. Your project codename is now saved as marigold-0469. I replaced the old entry, so there's one codename on record.

