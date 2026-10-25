# Task t01-files: Files, tool choice

## Rubric
The bot looked at the folder with its file tools (a listing, or a command that sizes the files) instead of guessing. The reply gives the right number of .md files counting the subfolder and names the largest one (the fixture has a larger .txt file that must not be named as the largest markdown file). One short answer. Deduct for inventing files or for a count that skips the subfolder.

## What the harness did with approval cards
policy: approve (expected: possible)

- card at 3.1s: tool `bash`, preview: "find /Users/wasimjalali/UsefulBotGolden/run/t01-files -type f -name '*.md' -exec ls -l {} \\; 2>&1 | head -100\nchanges files outside a project folder" -> approve

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating reply_has_md_count: expected 8 .md files; reply names that number
- [PASS] gating reply_has_largest_md: largest is sub/design-notes.md (3116 bytes); reply names it
- [PASS] gating tree_unchanged: changed/removed: []; added: []

## Turns
### Turn 1
Owner: How many .md files are in /Users/wasimjalali/UsefulBotGolden/run/t01-files (including subfolders), and which one is the largest?

Timeout: False  Wall: 9.12s

Bot (as shown in the transcript):
8 .md files, including the subfolder.
The largest is sub/design-notes.md at 3,116 bytes.
For reference, the other seven: alpha.md (237), delta.md (1,082), gamma.md (691), epsilon.md (400), plan.md (833), beta.md (464), and sub/todo.md (63).

