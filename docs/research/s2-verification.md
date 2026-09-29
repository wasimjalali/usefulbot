# S2 spike evidence (eve channel)

Recorded 2026-09-12. Live `eve dev --no-ui --host 127.0.0.1 --port 4327` with
`UB_S2_FIXTURE=1` and a per-run HS256 secret. No Vercel, no `localDev`, no
`placeholderAuth`, no `none()`.

## Result

9/9 PASS. See `spikes/s2/REPORT.md`.

| Finding | Consequence |
|---|---|
| `eve start` and `eve dev` both accept `--host` and `--port` | S2 bind is `127.0.0.1:4327`; production bind remains `127.0.0.1:4321` |
| Public durable store is project `.eve/` | Permitted spec fallback; gitignored |
| Custom `LanguageModel` needs `modelContextWindowTokens` | Without it eve exits: compaction has no Gateway metadata |
| Default eve channel does not bind sessions to principals | Ownership is first-claim in `agent/channels/eve.ts`; durable store is later |
