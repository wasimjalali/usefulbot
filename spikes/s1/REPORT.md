# S1 spike report: OpenCode Go alias behaviour

Generated: 2026-09-12T20:20:17.935Z

Node: 24.11.1. opencode: 1.18.26. CLI help captured from `opencode run --help`.

This report is partial: scope aliases [reviewer], cases [window].

## Results

| Alias | Model | Case | Status | Wall ms | Note |
|---|---|---|---|---:|---|
| workhorse | opencode-go/glm-5.3-flash | nonstream | PASS | 3845 |  |
| workhorse | opencode-go/glm-5.3-flash | stream | PASS | 4291 |  |
| workhorse | opencode-go/glm-5.3-flash | tool-roundtrip | PASS | 6605 |  |
| workhorse | opencode-go/glm-5.3-flash | fragmented-arguments | PASS | 0 |  |
| workhorse | opencode-go/glm-5.3-flash | reasoning-replay | PASS | 0 |  |
| workhorse | opencode-go/glm-5.3-flash | window | PASS | 0 |  |
| reviewer | opencode-go/glm-5.3 | nonstream | PASS | 4326 |  |
| reviewer | opencode-go/glm-5.3 | stream | PASS | 4250 |  |
| reviewer | opencode-go/glm-5.3 | tool-roundtrip | PASS | 5518 |  |
| reviewer | opencode-go/glm-5.3 | fragmented-arguments | PASS | 0 |  |
| reviewer | opencode-go/glm-5.3 | reasoning-replay | PASS | 0 |  |
| reviewer | opencode-go/glm-5.3 | window | PASS | 0 |  |

## What this proves

- workhorse nonstream: PASS. exit 0
- workhorse stream: PASS. exit 0, 3 events, final text "S1-NONSTREAM-OK"
- workhorse tool-roundtrip: PASS. exit 0, final text "S1-TOOL-PLANT-001", tools [read]
- workhorse fragmented-arguments: PASS. exit 0, final text "FRAG-DONE", tools [write, bash]
- workhorse reasoning-replay: PASS. 
- workhorse window: PASS. highest accepted input 937684 tokens
- reviewer nonstream: PASS. exit 0
- reviewer stream: PASS. exit 0, 3 events, final text "S1-NONSTREAM-OK"
- reviewer tool-roundtrip: PASS. exit 0, final text "S1-TOOL-PLANT-001", tools [read]
- reviewer fragmented-arguments: PASS. exit 0, final text "FRAG-DONE", tools [write]
- reviewer reasoning-replay: PASS. 
- reviewer window: PASS. highest accepted input 937588 tokens


## What this does not prove

- The harness cannot observe token level tool argument deltas through `--format json`, which emits a completed tool part. It proves the final argument reassembled and the written file matched; it does not prove where a delta boundary fell.
- The harness cannot observe whether the provider re-accepts stored reasoning content on replay. It proves the continuation turn recalled the planted value; upstream reasoning transport is only visible with provider debug logs, which were not enabled.
- The window boundary is measured with generated filler text. Token counts are the provider reported `tokens.input` from the CLI, but the filler is not the production prompt and its tokenization differs.
- Results reflect one macOS machine and the OpenCode Go quota state observed during the run. They do not prove sustained throughput, rate limits or availability.
- Nonstream and stream replies are compared against the same chosen constant token, not against each other in a single run.

## Raw CLI help (authority for flags)

```

```
