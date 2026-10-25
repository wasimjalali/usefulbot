# Task t10-long-chat: Long chat, six turns

## Rubric
All six turns were answered in one chat. The final index.html has the renamed title and heading, four list items including Rosemary and the dark green heading colour (checked). The turn-5 answer lists the changes since the first version correctly: the rename from Garden Notes to Kitchen Garden, the added Rosemary item and the new heading colour, with nothing invented and nothing missing (context held across turns). The turn-6 answer reads the real file back (it matches what is on disk), not a reconstruction. Deduct for re-creating the page from scratch when an edit was asked, or for answering from memory without reading the file in turn 6.

## What the harness did with approval cards
policy: approve (expected: possible)

- card at 3.0s: tool `bash`, preview: 'changes files outside a project folder\nls -la /Users/wasimjalali/UsefulBotGolden/run/t10-long-chat 2>&1; echo "---"; ls -la /Users/wasimjalali/UsefulBotGolden/run/t10-long-chat/index.html 2>&1' -> approve
- card at 4.0s: tool `write_file`, preview: 'write /Users/wasimjalali/UsefulBotGolden/run/t10-long-chat/index.html: <!DOCTYPE html> <html lang="en"> <head> <meta charset="UTF-8"> <meta name="viewport" content="width=device-width, initial-scale=1"> <title>Kitchen Garden</title> </head> <body> <h1>Kitchen Garden</h1> <ul> <li>Tomatoes</li> <li>Basil</li> <li>Mint</li> </ul> </body> </html>' -> approve
- card at 5.0s: tool `write_file`, preview: 'write /Users/wasimjalali/UsefulBotGolden/run/t10-long-chat/index.html: <!DOCTYPE html> <html lang="en"> <head> <meta charset="UTF-8"> <meta name="viewport" content="width=device-width, initial-scale=1"> <title>Kitchen Garden</title> </head> <body> <h1>Kitchen Garden</h1> <ul> <li>Tomatoes</li> <li>Basil</li> <li>Mint</li> <li>Rosemary</li> </ul> </body> </html>' -> approve
- card at 5.0s: tool `write_file`, preview: 'write /Users/wasimjalali/UsefulBotGolden/run/t10-long-chat/index.html: <!DOCTYPE html> <html lang="en"> <head> <meta charset="UTF-8"> <meta name="viewport" content="width=device-width, initial-scale=1"> <title>Kitchen Garden</title> <style> h1 { color: #1b5e20; } </style> </head> <body> <h1>Kitchen Garden</h1> <ul> <li>Tomatoes</li> <li>Basil</li> <li>Mint</li> <li>Rosemary</li> </ul> </body> </html>' -> approve

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking
- 2.0: Running a command
- 5.0: Thinking
- 0.0: Thinking
- 3.0: Writing a file
- 6.0: Thinking
- 0.0: Thinking
- 3.0: Writing a file
- 7.0: Thinking
- 0.0: Thinking
- 3.0: Writing a file
- 7.1: Thinking
- 0.0: Thinking
- 0.0: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating html_final: title, h1, four items and colour all present
- [PASS] info reply_regex: /(?s)(?=.*kitchen)(?=.*rosemary)(?=.*(green|1b5e20))/ on turn 4: match
- [PASS] info reply_regex: /(?s)(?=.*kitchen garden)(?=.*rosemary)/ on turn 5: match

## Turns
### Turn 1
Owner: Create index.html in /Users/wasimjalali/UsefulBotGolden/run/t10-long-chat with a page title and one h1 that both read "Garden Notes", and under it a bulleted list of three items: Tomatoes, Basil, Mint.

Timeout: False  Wall: 8.0s

Bot (as shown in the transcript):
Garden Notes
Created /Users/wasimjalali/UsefulBotGolden/run/t10-long-chat/index.html. Title and h1 both read "Garden Notes", with a list of Tomatoes, Basil and Mint. I read it back to confirm, and it's open as a preview in the chat too.

### Turn 2
Owner: Rename the page title and the heading to "Kitchen Garden".

Timeout: False  Wall: 7.98s

Bot (as shown in the transcript):
Done. The page title and the h1 now both read "Kitchen Garden", and the list of Tomatoes, Basil and Mint is unchanged. I read the file back to confirm.

### Turn 3
Owner: Add a fourth list item: Rosemary.

Timeout: False  Wall: 9.03s

Bot (as shown in the transcript):
Added Rosemary as the fourth item. The list now reads Tomatoes, Basil, Mint, Rosemary, and the title and h1 still say "Kitchen Garden". Read back to confirm.

### Turn 4
Owner: Make the heading dark green, #1b5e20.

Timeout: False  Wall: 9.07s

Bot (as shown in the transcript):
The heading is now dark green (#1b5e20), set with a small style block in the page head. Everything else is unchanged, and I read the file back to confirm.

### Turn 5
Owner: What changed in the page since the first version you wrote?

Timeout: False  Wall: 2.01s

Bot (as shown in the transcript):
Three changes since the first version:
1.
The page title and the h1 changed from "Garden Notes" to "Kitchen Garden".
2.
A fourth list item, Rosemary, was added after Mint.
3.
A <style> block in the head now sets the h1 to #1b5e20 dark green.
The rest is the same: same file path, same doctype,

### Turn 6
Owner: Read the file back to me.

Timeout: False  Wall: 3.02s

Bot (as shown in the transcript):
Current contents of index.html (379 bytes):
```
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kitchen Garden</title>
  <style>
    h1 {
      color: #1b5e20;
    }
  </style>
</head>
<body>
  <h1>Kitchen Garden</h1>
  <ul>
    <li>Tomatoes</li>
    <li>Basil</li>
    <li>Mint</li>
    <li>Rosemary</li>
  </ul>
</body>
</html>
```
That's the whole file, unchanged since the colour change.

