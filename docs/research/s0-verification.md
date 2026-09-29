# S0 spike evidence (Phase 0 runtime gate)

Recorded 2026-09-12 on the owner's Apple M1 Mac. This file is the evidence behind the plan's
runtime row and the spec's S0 gate. Everything below was observed on this machine, not inferred.

## 1. Node 24 pin

| Check | Result |
|---|---|
| Login shell `node` | `~/.local/bin/node`, **v22.23.1** (below eve's requirement) |
| Absolute interpreter used | `/usr/local/bin/node`, **v24.11.1** |
| Consequence | Every run script, launchd plist and verification command must call the absolute Node 24 path or set `PATH=/usr/local/bin:$PATH` first |

## 2. Pinned dependency install (temp dir `/tmp/ub-spike-s0`)

Installed with `npm install --save-exact`. Resolved versions, recorded to be pinned in the real
manifests in PR 2:

| Package | Version |
|---|---|
| `eve` | `0.54.3` |
| `ai` | `7.0.99` |
| `@ai-sdk/openai-compatible` | `3.0.48` |
| `zod` | `4.6.2` |
| `typescript` | `7.0.2` |

`npx eve --version` reports `0.54.3`.

## 3. `node:sqlite` and FTS5

`DatabaseSync(':memory:')` with `CREATE VIRTUAL TABLE ... USING fts5(body)` succeeded, and a MATCH
query returned the inserted row. Node prints an ExperimentalWarning for the SQLite module, so the
dependency on FTS5 is real but the module is not yet stable in Node 24.

## 4. eve CLI surface as installed

Commands present: `init`, `dev`, `logs`, `traces`, `info`, `eval`, `invoke`, `acp`, `build`,
`start`, `deploy`, `set`, `link`, `add`, `registry`, `integration`, `extension`, `channels`,
`telemetry`.

Flags that matter to this project:

- `eve init [target] --model <provider/model-id> --reasoning <effort> --channel-web-nextjs --agents <names>`
- `eve dev [url]` starts the dev server and a terminal REPL. The scaffold's own `AGENTS.md`
  documents `npm exec -- eve dev --no-ui` for a controllable background process, with the HTTP
  session API (`POST /eve/v1/session`, `GET /eve/v1/session/:id/stream`, `POST /eve/v1/session/:id`)
  as the way to exercise the agent. The verification runner uses that shape.
- `eve invoke` runs one agent turn without a TUI.

## 5. Scaffold probe

`npx eve@0.54.3 init probe-app --model openai/gpt-5.6-luna` in a clean temp directory produced:

```
probe-app/
├── .gitignore
├── .vercelignore
├── AGENTS.md
├── CLAUDE.md
├── README.md
├── agent/
│   ├── agent.ts          # defineAgent({ model: "openai/gpt-5.6-luna" })
│   ├── channels/eve.ts
│   └── instructions.md   # "# Identity / You are a helpful assistant."
├── package.json
├── package-lock.json
└── tsconfig.json
```

Two findings worth carrying into PR 2:

1. `eve init` refuses to run when the working directory already contains a `package.json` and no
   agent files ("Invalid eve project ... found no agent files"). Scaffolding must happen in a clean
   directory, then the needed files are copied into the repo deliberately.
2. The scaffold ships `agent/channels/eve.ts` already present, which is the file the spec replaces
   with the real auth policy.

## 6. Keyless search probe

`POST https://api.firecrawl.dev/v2/search` with no API key: **HTTP 200 in 1.24s**, body
`{success, data:{web:[{url,title,description}]}, creditsUsed, id}`. The hosted keyless MCP endpoint
(`https://mcp.firecrawl.dev/v2/mcp`) also completed its handshake (server `firecrawl-fastmcp`
3.24.1). No rate-limit or quota headers are returned, so 429 is the only limit signal.

## 7. Harness probe for the execution pipeline

| Check | Result |
|---|---|
| `dsh --version` | `0.1.2-rc.1` |
| `dsh --profile headless "<task>"` | Runs, reaches OpenCode Go, returned a weekly-limit 429 on its default model |
| `dsh` provider config | Already points at OpenCode Go, with reasoning efforts `high` and `max` configured |
| `opencode-go/deepseek-v4.1-flash` | Live reply confirmed |
| `opencode-go/glm-5.3` | Live reply confirmed |
| Grok Build CLI | Installed, **not authenticated** (`grok models` reports "You are not authenticated") |

## Not yet proved

S1, S2 and S3 evidence now lives in `s1-verification.md`, `s2-verification.md` and
`s3-verification.md`. This file only claims S0.
