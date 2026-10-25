# Task t04-web-search: Web search

## Rubric
The bot searched the web (the transcript or the activity labels show a search or a page fetch) instead of answering from memory, gave one concrete Node.js version number and cited a URL for it (nodejs.org or the project's GitHub releases are the expected sources). Judge the version for plausibility against the page the bot cites, not against your own knowledge of Node: a version the cited page supports passes. Deduct for no citation, for a vague answer, or for an LTS line mixed up with the latest stable release without saying so.

## What the harness did with approval cards
policy: approve (expected: none)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 8.1: Thinking
- 9.1: Using web fetch
- 10.1: Thinking
- 12.1: Writing

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating reply_regex: /\bv?\d{1,2}\.\d+\.\d+\b/ on turn -1: match
- [PASS] gating reply_regex: /https?:/// on turn -1: match
- [PASS] info activity_seen: labels matching: ['Using web fetch']

## Turns
### Turn 1
Owner: What's the latest stable Node.js release? Cite the page.

Timeout: False  Wall: 13.15s

Bot (as shown in the transcript):
I'll check the official Node.js release page.
- Newest release (Current): Node.js 26.12.1, last updated Oct 21, 2026. Still in the six-month Current phase, so it is not LTS yet.
- Latest LTS (what production should use): Node.js 24.22.1 "Krypton".
Source: https://nodejs.org/en/about/previous-releases (
One note: v24 became Maintenance LTS on Oct 20, 2026, so it now gets security fixes only. If you're picking a version for a new project, LTS 24 is the safe choice.
Two answers, depending on which "stable" you mean:

