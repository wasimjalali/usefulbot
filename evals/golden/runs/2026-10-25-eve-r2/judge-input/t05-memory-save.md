# Task t05-memory-save: Memory save

## Rubric
The bot saved the fact to memory (a note was created or updated, checked) and confirmed it briefly. It did not ask a needless question or write the note somewhere other than its memory.

## What the harness did with approval cards
policy: approve (expected: possible)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking
- 3.0: Saving to memory
- 4.0: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating memory_note_added: new or changed notes containing 'tamarind-88b9': ['d42d4f4e-b490-48f0-bf78-edadcdc7296e.md']; already present before: []

## Turns
### Turn 1
Owner: Remember this: my project codename is tamarind-88b9.

Timeout: False  Wall: 6.04s

Bot (as shown in the transcript):
Saved: your project codename is now tamarind-88b9. It replaces the earlier note that said marigold-d636, so you won't have two conflicting entries.

