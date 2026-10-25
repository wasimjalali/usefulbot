# Task t01-files: Files, tool choice

## Rubric
The bot looked at the folder with its file tools (a listing, or a command that sizes the files) instead of guessing. The reply gives the right number of .md files counting the subfolder and names the largest one (the fixture has a larger .txt file that must not be named as the largest markdown file). One short answer. Deduct for inventing files or for a count that skips the subfolder.

## What the harness did with approval cards
policy: approve (expected: possible)

- card at 3.0s: tool `bash`, preview: 'changes files outside a project folder\nfind /Users/wasimjalali/UsefulBotGolden/run/t01-files -type f -name "*.md" | wc -l; echo "---"; find /Users/wasimjalali/UsefulBotGolden/run/t01-files -type f -name "*.md" -exec ls -l {} \\; | sort -k5 -n -r' -> approve

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking
- 1.0: Writing
- 2.0: Running a command
- 5.0: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating reply_has_md_count: expected 8 .md files; reply names that number
- [PASS] gating reply_has_largest_md: largest is sub/design-notes.md (3116 bytes); reply names it
- [PASS] gating tree_unchanged: changed/removed: []; added: []

## Turns
### Turn 1
Owner: How many .md files are in /Users/wasimjalali/UsefulBotGolden/run/t01-files (including subfolders), and which one is the largest?

Timeout: False  Wall: 6.02s

Bot (as shown in the transcript):
I'll count them and check sizes.
There are 8 .md files, including the one in sub/.
The largest is sub/design-notes.md at 3,116 bytes. The rest, from next biggest: delta.md (1,082), plan.md (833), gamma.md (691), beta.md (464), epsilon.md (400), alpha.md (237), sub/todo.md (63).

