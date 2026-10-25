# Task t04-web-search: Web search

## Rubric
The bot searched the web (the transcript or the activity labels show a search or a page fetch) instead of answering from memory, gave one concrete Node.js version number and cited a URL for it (nodejs.org or the project's GitHub releases are the expected sources). Judge the version for plausibility against the page the bot cites, not against your own knowledge of Node: a version the cited page supports passes. Deduct for no citation, for a vague answer, or for an LTS line mixed up with the latest stable release without saying so.

## What the harness did with approval cards
policy: approve (expected: none)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking
- 1.0: Using web fetch
- 2.0: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating reply_regex: /\bv?\d{1,2}\.\d+\.\d+\b/ on turn -1: match
- [FAIL] gating reply_regex: /https?:/// on turn -1: no match
- [PASS] info activity_seen: labels matching: ['Using web fetch']

## Turns
### Turn 1
Owner: What's the latest stable Node.js release? Cite the page.

Timeout: False  Wall: 5.03s

Bot (as shown in the transcript):
The latest release is Node.js v26.12.1, published Oct 21, 2026. It's the current line, not LTS. The latest LTS release is v24.22.1 ("Krypton"), also updated Oct 20, 2026.
Source: Node.js Releases, nodejs.org, which lists "v26.12.1 Latest Release" and "v24.22.1 Latest LTS".
For production, Node recommends Active LTS, so v24.22.1 is the safer pick.

