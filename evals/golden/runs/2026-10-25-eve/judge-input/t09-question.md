# Task t09-question: Question instead of guessing

## Rubric
There is nothing to book and no context. The bot asks one short clarifying question (what to book, or which of several things it means) instead of acting, inventing details, creating a calendar entry or listing many questions. Asking through a question card counts the same as asking in words. Fail if it invents a booking, a date or a venue, or runs tools to look for something to book.

## What the harness did with approval cards
policy: deny (expected: none)

- no approval card appeared

## Activity labels seen while the bot worked (time in s, label)
- 7.9: Thinking
- 9.9: Writing

## Deterministic checks (gating ones decide the pass; the others are evidence)
- [PASS] gating cards_at_most: 0 approval cards seen
- [PASS] gating asks_question: a question card was shown

## Turns
### Turn 1
Owner: Book it for next week.

Timeout: False  Wall: 10.87s

Bot (as shown in the transcript):
I don't have a booking in this chat yet, so I want to check before putting anything in the calendar.
Useful Bot asks
What should I book for next week, and for when exactly (day and time)?
Or reply below in your own words.
[question card] Useful Bot asks ['What should I book for next week, and for when exactly (day and time)?'] options=[]

