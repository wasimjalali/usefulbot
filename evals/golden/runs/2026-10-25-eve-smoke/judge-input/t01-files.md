# Task t01-files: Files, tool choice

## Rubric
The bot looked at the folder with its file tools (a listing, or a command that sizes the files) instead of guessing. The reply gives the right number of .md files counting the subfolder and names the largest one (the fixture has a larger .txt file that must not be named as the largest markdown file). One short answer. Deduct for inventing files or for a count that skips the subfolder.

## What the harness did with approval cards
policy: approve (expected: possible)

- card at 11.0s: tool `bash`, preview: '' -> approve

## Activity labels seen while the bot worked (time in s, label)
- 8.0: Thinking
- 9.0: Running a command
- 10.0: Running a command: find

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating reply_has_md_count: expected 8 .md files; reply names that number
- [PASS] gating reply_has_largest_md: largest is sub/design-notes.md (3116 bytes); reply names it
- [PASS] gating tree_unchanged: changed/removed: []; added: []

## Turns
### Turn 1
Owner: How many .md files are in /Users/wasimjalali/UsefulBotGolden/2026-10-25-eve-smoke/t01-files (including subfolders), and which one is the largest?

Timeout: False  Wall: 14.18s

Bot (as shown in the transcript):
The largest is sub/design-notes.md at 3,116 bytes. Next largest is delta.md at 1,082 bytes.
There are 8 .md files in that folder, counting subfolders.

