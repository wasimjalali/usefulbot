# S2 spike report: eve channel auth, ownership, cancel

Generated: 2026-09-12T20:56:42.228Z

| Case | Status | Note |
|---|---|---|
| health-anonymous | PASS |  |
| info-anonymous-denied | PASS |  |
| session-anonymous-denied | PASS |  |
| authenticated-create | PASS |  |
| ownership-other-principal | PASS |  |
| tool-result | PASS |  |
| cancel | PASS |  |
| reconnect-no-resubmit | PASS |  |
| secret-not-in-logs | PASS |  |

## Bind and store

- eve start/dev support `--host` and `--port`. S2 used `127.0.0.1:4327`.
- Durable store is project `.eve/` (the only public fallback in eve 0.54.3). gitignored.
- Auth is `jwtHmac` only. No `localDev`, `placeholderAuth` or `none`.
- Channel JWT secret is generated per probe, passed through env, never written to the repo.
