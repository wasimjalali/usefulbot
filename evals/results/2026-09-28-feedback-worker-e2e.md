# Feedback Worker E2E, 2026-09-28

## Question

Does the feedback Worker (`services/feedback/`) store only valid feedback, hold both daily limits under
parallel load, mail only Problems and build a correct weekly digest, before it goes live?

## What ran

- `services/feedback/e2e.mjs` against `wrangler dev` 4.143.0 (Node 22.23.1) with a local D1 built from
  `migrations/0001_feedback.sql` and Cloudflare's local email simulation. Base commit `485533c`, branch
  `feat/first-run-and-settings`.
- Command: `cd services/feedback && npm ci && node e2e.mjs`.
- Cost: none (all local).

The failure list was written first (the header of `e2e.mjs`): bad requests stored, loose field
validation, the install limit, the network limit, a parallel burst past the limit, a 429 the app
can't show, the raw IP reaching D1, the wrong kinds sending mail, unescaped HTML in mail, and a wrong
digest window.

## Numbers

32 of 32 cases passed on the first run. Raw results: `2026-09-28-feedback-worker-e2e.json`.

The hard ones:

- 10 parallel sends from one install stored exactly 5, and D1 held exactly 5 rows. The limit check
  and the insert are one SQL statement, so there's no read-then-write gap.
- 20 sends from one network with 20 different installs passed; the 21st got 429 with scope `network`.
- 4,000 emoji (8,000 UTF-16 units) passed and were stored whole; 4,001 characters were refused.
  Length is counted in code points, the same unit as SQLite's `length()` in the table's CHECK.
- A reply email carrying `\r\nBcc:` was refused, so it can't inject a header through Reply-To.
- The Problem email had `<script>` escaped. Idea and Other sent no mail.
- The digest counted 1 idea, 1 problem and 1 other for the week and left out a row 8 days old.

## Conclusion

The Worker is ready to deploy.

## Live check (same day)

Deployed to `feedback.usefulbuild.com` (version `0490b30d`). An invalid body got 400. A real Problem
got 201, and its row is in D1 with a 64-character `ip_hash` and no raw IP. The owner confirmed the
email reached the `hello@` inbox. One snag: this Mac's router cached an NXDOMAIN from a lookup made
before the custom domain existed, so the name kept failing locally for over two hours while public
resolvers answered. Deploy the Worker before anything looks the name up.

## What changed because of it

The app ships `UBFeedbackURL` pointing at this Worker, and Settings > Feedback posts to it.
