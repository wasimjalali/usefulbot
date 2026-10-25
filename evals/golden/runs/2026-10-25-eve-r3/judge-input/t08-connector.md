# Task t08-connector: Connector (DeepWiki)

## Rubric
The bot used the connected DeepWiki tool (the activity labels or an approval card name it) rather than answering from its own knowledge, and gave a one-line description that is right: facebook/react is the React library for building user interfaces (a JavaScript library). If the DeepWiki call failed, the bot says so instead of pretending. Deduct for a long answer when one line was asked.

## What the harness did with approval cards
policy: approve (expected: possible)

- card at 3.0s: tool `connection`, preview: 'DeepWiki · ask_wiki_question\n{\n "repoName": "facebook/react",\n "question": "In one sentence, what is this repository?"\n}' -> approve

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking
- 3.0: Using deepwiki  ask wiki question
- 14.4: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating reply_regex: /react/ on turn -1: match
- [PASS] info activity_seen: labels matching: ['Using deepwiki  ask wiki question']

## Turns
### Turn 1
Owner: Using DeepWiki, tell me in one line what the repo facebook/react is.

Timeout: False  Wall: 15.38s

Bot (as shown in the transcript):
facebook/react is the open-source codebase for the React JavaScript library, used to build user interfaces.

