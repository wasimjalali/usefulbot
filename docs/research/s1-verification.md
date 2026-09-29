# S1 spike evidence (OpenCode Go aliases)

Recorded 2026-09-12 on the owner's Apple M1 Mac. Live `opencode run` against
`opencode-go/glm-5.3-flash` (workhorse, `--variant low`) and `opencode-go/glm-5.3`
(reviewer, `--variant high`). The harness is `spikes/s1/probe.mjs`. It never
reads a credential file.

## Result

12/12 PASS. Highest accepted input tokens: workhorse 937,684, reviewer 937,588.
v1 policy window is 131,072 (inside that floor). Effort flag is `--variant`, not `--reasoning`.

See `spikes/s1/REPORT.md` and `spikes/s1/results.json`.
