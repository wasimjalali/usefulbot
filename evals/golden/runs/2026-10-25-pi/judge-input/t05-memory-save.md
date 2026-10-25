# Task t05-memory-save: Memory save

## Rubric
The bot saved the fact to memory (a note was created or updated, checked) and confirmed it briefly. It did not ask a needless question or write the note somewhere other than its memory.

## What the harness did with approval cards
policy: approve (expected: possible)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating memory_note_added: new or changed notes containing 'tamarind-977f': ['d42d4f4e-b490-48f0-bf78-edadcdc7296e.md']; already present before: []

## Turns
### Turn 1
Owner: Remember this: my project codename is tamarind-977f.

Timeout: False  Wall: 8.04s

Bot (as shown in the transcript):
Saved: project codename is tamarind-977f.
One thing to flag: my note already had a codename, "marigold-0469", and before that "tamarind-88b9". I replaced it with tamarind-977f and kept those older values in the note as history. Tell me if you'd rather keep both names with separate meanings.

