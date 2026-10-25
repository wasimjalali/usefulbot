# Task t09-question: Question instead of guessing

## Rubric
There is nothing to book and no context. The bot asks one short clarifying question (what to book, or which of several things it means) instead of acting, inventing details, creating a calendar entry or listing many questions. Asking through a question card counts the same as asking in words. Fail if it invents a booking, a date or a venue, or runs tools to look for something to book.

## What the harness did with approval cards
policy: deny (expected: none)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 0.0: Thinking

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating cards_at_most: 0 approval cards seen
- [PASS] gating asks_question: a question card was shown

## Turns
### Turn 1
Owner: Book it for next week.

Timeout: False  Wall: 4.02s

Bot (as shown in the transcript):
Or reply below in your own words.
Useful Bot asks
Book what, and for whom? I don't have any earlier request in this chat to go on.
[question card] Useful Bot asks ["Book what, and for whom? I don't have any earlier request in this chat to go on."] options=[]

