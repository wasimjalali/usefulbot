# iOS build — owner checklist

Every owner-run gate the build chain recorded red, collected for the owner to
run after the chain finishes. Each item names its step, its expected result,
and the PR that added it. Red is never rewritten as skipped: an item stays
red until the owner runs it and records the outcome here.

The order below is not cosmetic. It is §19's enable order: server changes on
loopback first, phone access last, remote exposure in between only after the
code is verified.

---

## 1. Deploy order (PR-2 — the whole chain depends on this sequence)

1. Deploy the server changes S1–S15 on the Mac and restart services with
   `phoneEnabled: false` in `~/.useful-bot/config.json`.
   - Expected: all loopback surfaces behave exactly as before — macOS app,
     web UI, CLI. This is the regression point; a loopback break here is a
     server bug, not a phone bug.
   - Verify: `node scripts/verify-release.mjs` green on the Mac; open the
     macOS app and the web UI, send one turn to any bot.
2. `node scripts/setup-local.mjs --pair-phone`.
   - Expected: a `device-phone` credential row is minted and the pairing
     payload is printed (`{"v":1,"host","token","name"}`). Phone access is
     still inert — `phoneEnabled` is still false.
3. Set `phoneEnabled: true` in `~/.useful-bot/config.json`; restart the web
     service.
4. `tailscale serve` the web service to tailnet HTTPS (the Serve config in
   this build's notes — Serve forwards only to 127.0.0.1:4320, never 4319).
   - Expected: `tailscale serve status` shows the single forwarding entry;
     `tailscale funnel status` is off. The tailnet ACL grants the phone's
     tailnet identity → this Mac on :443 only; no broad rule implicitly
     covers it.
5. **Real-Serve check** (below). Only after it passes does the QR go to the
   phone: `node scripts/setup-local.mjs --print-pairing --host <serve-url>`
   and scan with the iOS app, or enter manually.

## 2. Real-Serve check (PR-2 gate — recorded red, owner-run)

This verifies the deployed Tailscale build's Serve behavior the classifier
(S3) depends on. Cloud VMs cannot run Tailscale; this is the step that can
only run on the owner's hardware.

For each check, run it and record pass/fail against the expected result:

- **Serve header set.** With Serve forwarding to 127.0.0.1:4320, hit the
  tailnet URL from the phone's browser and capture what Next sees (the app
  logs the ingress classification per request). Expected on every request:
  `X-Forwarded-For` first hop in `100.64.0.0/10`, `X-Forwarded-Proto:
  https`, `Tailscale-User-Login` equal to `tailnet.userLogin`, `Host` and
  `X-Forwarded-Host` the Serve URL host. If the deployed version emits
  different names or needs a flag for identity headers, record the drift —
  the classifier's header set must match reality, not the other way round.
- **Loopback vs tailnet classification.** A request over Serve with valid
  headers classifies `tailnet`; the same request on 127.0.0.1 with no proxy
  headers classifies `loopback`; any mixed or partial header set classifies
  `unknown` → 403 `ingress`. Try a desktop-profile cookie over Serve: it is
  rejected (F4 — the cookie never legitimately leaves the Mac).
- **Phone session over Serve.** Sign in (the pairing token → session
  exchange) over the tailnet URL: session minted as a phone-profile session
  with a `Secure` cookie; the session survives only while the credential is
  valid (S9).
- **Revocation is immediate.** `--revoke-phone` on the Mac → the phone's
  very next request 401s and the iOS app lands in `credentialInvalid`
  ("This pairing was revoked or expired"). Expected latency: one request,
  no cache.
- **Deny matrix.** With `phoneEnabled: false`, a Serve request carrying
  proxy headers is `unknown` → 403 — phone access can never be enabled by
  exposure alone.

## 3. Install to the iPhone (PR-2 — recorded red, owner-run)

- Open `ios/UsefulBot.xcodeproj` (generated: `cd ios && xcodegen generate`),
  sign with the owner's team, install to the phone via Xcode. Free
  provisioning is acceptable for v1 dev; the 7-day re-sign nuisance is a
  known cost (§19). Q7 (Apple Developer account) is the owner's call and
  gates only TestFlight/App Store, not this install.
- Expected: the app installs, launches to the pairing screen, and pairs via
  QR scan and via manual entry (the same checklist as the simulator legs).

## 4. Rollback order (PR-2 — record under this PR if exercised)

Reverse order only: `tailscale serve reset` (remote exposure off first) →
`--revoke-phone` (invalidates phone sessions immediately via S9) → revert
code and restart services. Never revert code while Serve is still
forwarding.

---

## Record

| Gate | PR | Owner ran | Outcome |
|------|----|-----------|---------|
| Deploy order §19 | 2 | ☐ | |
| Real-Serve check | 2 | ☐ | |
| Install to iPhone | 2 | ☐ | |
| Rollback order | 2 | ☐ | |
