# Task t01-files: Files, tool choice

## Rubric
The bot looked at the folder with its file tools (a listing, or a command that sizes the files) instead of guessing. The reply gives the right number of .md files counting the subfolder and names the largest one (the fixture has a larger .txt file that must not be named as the largest markdown file). One short answer. Deduct for inventing files or for a count that skips the subfolder.

## What the harness did with approval cards
policy: approve (expected: possible)

- card at 2.0s: tool `bash`, preview: 'find /Users/wasimjalali/UsefulBotGolden/2026-10-25-eve-r2/t01-files -type f -name \'*.md\' -print0 | xargs -0 -I{} stat -f \'%z %N\' {} | sort -rn | awk \'{print $1" "$2}\'\nchanges files outside a project folder' -> approve

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking
- 1.0: Running a command: find

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [FAIL] gating reply_has_md_count: expected 8 .md files; reply does not name that number
- [FAIL] gating reply_has_largest_md: largest is sub/design-notes.md (3116 bytes); reply does not name it
- [PASS] gating tree_unchanged: changed/removed: []; added: []

## Turns
### Turn 1
Owner: How many .md files are in /Users/wasimjalali/UsefulBotGolden/2026-10-25-eve-r2/t01-files (including subfolders), and which one is the largest?

Timeout: False  Wall: 5.57s

Bot (as shown in the transcript):
Done. index.html is in that folder, with title and h1 both "Garden Notes" and the three list items under it. Read back to confirm.
Renamed. The <title> and the <h1> now both read "Kitchen Garden"; the list is unchanged.
Added. The list now reads Tomatoes, Basil, Mint, Rosemary, and the title and heading are unchanged.
Done. A <style> block now sets the h1 to #1b5e20; nothing else changed.
Three changes since the first version:
1.
Renamed the <title> and <h1> from "Garden Notes" to "Kitchen Garden".
2.
Added a fourth list item, Rosemary, after Mint.
3.
Added a <style> block in the head setting the h1 colour to #1b5e20 (dark green).
Everything else is as first written: the doctype, the charset and viewport meta tags, the three original herbs, and the list order. The file grew from 295 to 369 bytes.
Current contents of /Users/wasimjalali/UsefulBotGolden/2026-10-25-eve/t10-long-chat/index.html:
369 bytes, 19 lines.

