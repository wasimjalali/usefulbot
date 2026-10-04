# PR #179: connect-flow behaviour after the instruction cuts (2026-10-03)

Question: the re-enabled sub-agent paragraph pushed agent/instructions.md to the 950-word cap, and lines
were cut ('continue without asking again after a connect or approve', 'ask what an approval card will
ask', and three already covered by tool descriptions). Do the connect flows regress?

Ran: scenarios S1, S3 and S4 of evals/results/2026-10-02-ub009-prc/behavior-scenarios.json, sent to
Test Bot (Useful Bot Dev, GLM 5.3 Flash Low) directly through eve with the dev channel token
(run-behavior-s1-s3-s4.sh; raw results behavior-s1-s3-s4.jsonl). Compared with behavior-after2.json.

| Scenario | 2026-10-02 (after2) | 2026-10-03 (this PR) |
|---|---|---|
| S1 Gmail | load_skill + connector_catalog, Composio key steps | connector_catalog, same Composio key steps |
| S3 MCP URL | propose_connection with a placeholder URL (wrong) | asks for the URL, then a Connect card |
| S4 Notion | connector_catalog, Composio key steps | same steps, plus the official Notion MCP option |

Conclusion: no regression; S3 improved. Small sample (one run each, one model), so it shows no breakage
rather than proving parity. Cost: three short turns on the owner's GLM plan.
