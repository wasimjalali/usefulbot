[0m
> build · hy4-preview
[0m
[0m$ [0mls -la /Users/wasimjalali/Desktop/useful-bot && ls -R /Users/wasimjalali/Desktop/useful-bot/docs 2>/dev/null | head -50
total 0
drwxr-xr-x@  5 wasimjalali  staff  160 Sep 12 19:37 .
drwx------@ 11 wasimjalali  staff  352 Sep 12 19:21 ..
drwxr-xr-x@  9 wasimjalali  staff  288 Sep 12 19:20 .git
drwxr-xr-x@  5 wasimjalali  staff  160 Sep 12 19:37 docs
drwxr-xr-x@  3 wasimjalali  staff   96 Sep 12 19:37 scripts
counsel
plan
research

/Users/wasimjalali/Desktop/useful-bot/docs/counsel:
01-muse-spark-1.3.md
02-glm-5.3-flash.md
03-hy4-preview.md
04-grok-4.6.md
BRIEF.md

/Users/wasimjalali/Desktop/useful-bot/docs/plan:
PLAN-v0.1.md

/Users/wasimjalali/Desktop/useful-bot/docs/research:
codex-model-catalog.json
[0m
[0m$ [0mls -la /Users/wasimjalali/Desktop/useful-bot/docs/plan /Users/wasimjalali/Desktop/useful-bot/docs/research 2>/dev/null
/Users/wasimjalali/Desktop/useful-bot/docs/plan:
total 40
drwxr-xr-x@ 3 wasimjalali  staff     96 Sep 12 19:36 .
drwxr-xr-x@ 5 wasimjalali  staff    160 Sep 12 19:37 ..
-rw-r--r--@ 1 wasimjalali  staff  20302 Sep 12 19:36 PLAN-v0.1.md

/Users/wasimjalali/Desktop/useful-bot/docs/research:
total 696
drwxr-xr-x@ 3 wasimjalali  staff      96 Sep 12 19:31 .
drwxr-xr-x@ 5 wasimjalali  staff     160 Sep 12 19:37 ..
-rw-r--r--@ 1 wasimjalali  staff  355384 Sep 12 19:31 codex-model-catalog.json
[0m
[0m$ [0mnode --version; command -v codex opencode microsandbox docker; ls ~/Library/Application\ Support 2>/dev/null | head -0; echo "---"; ls ~/.codex 2>/dev/null | sed 's/.*/[redacted]/' | head
v22.23.1
/Users/wasimjalali/.local/bin/codex
/opt/homebrew/bin/opencode
head: illegal line count -- 0
---
[redacted]
[redacted]
[redacted]
[redacted]
[redacted]
[redacted]
[redacted]
[redacted]
[redacted]
[redacted]
[0m
[0m$ [0mpython3 -c "
import json
d=json.load(open('docs/research/codex-model-catalog.json'))
print(type(d))
if isinstance(d,dict): print(list(d.keys())[:20])
if isinstance(d,list): print(len(d)); print(json.dumps(d[0])[:600])
"
<class 'dict'>
['models']
[0m
[0m$ [0mwhich -a node; ls ~/.nvm/versions/node 2>/dev/null; ls /opt/homebrew/opt | grep -i node; node -p "process.versions.node"
/Users/wasimjalali/.local/bin/node
/Users/wasimjalali/.local/bin/node
/Users/wasimjalali/.local/bin/node
/usr/local/bin/node
/Users/wasimjalali/.hermes/node/bin/node
/Users/wasimjalali/.local/bin/node
v22.22.2
v24.14.0
22.23.1
[0m
[0m$ [0mpython3 -c "
import json
d=json.load(open('docs/research/codex-model-catalog.json'))['models']
print(len(d))
print(json.dumps(d[:3],indent=1)[:1500])
"
7
[
 {
  "slug": "gpt-6-astra",
  "display_name": "GPT-6-Astra",
  "description": "Our most capable model for complex, demanding work.",
  "default_reasoning_level": "low",
  "supported_reasoning_levels": [
   {
    "effort": "low",
    "description": "Fast responses with lighter reasoning"
   },
   {
    "effort": "medium",
    "description": "Balances speed and reasoning depth for everyday tasks"
   },
   {
    "effort": "high",
    "description": "Greater reasoning depth for complex problems"
   },
   {
    "effort": "xhigh",
    "description": "Extra high reasoning depth for complex problems"
   },
   {
    "effort": "max",
    "description": "Maximum reasoning depth for the hardest problems"
   },
   {
    "effort": "ultra",
    "description": "Maximum reasoning with automatic task delegation"
   }
  ],
  "shell_type": "unified_exec",
  "visibility": "list",
  "supported_in_api": true,
  "priority": 1,
  "additional_speed_tiers": [
   "fast"
  ],
  "service_tiers": [
   {
    "id": "priority",
    "name": "Fast",
    "description": "2x speed, increased usage"
   }
  ],
  "default_service_tier": "priority",
  "availability_nux": {
   "message": "This is GPT-6, a new generation of intelligence. Astra is state-of-the-art in coding, computer use, science, and professional work. Give it a hard problem, a half-formed idea, or anything you've been meaning to build. See where it takes you."
  },
  "upgrade": null,
  "model_messages": {
   "persistent_instructions": "## Overview\nY
[0m
[0m$ [0mpython3 -c "
import json
d=json.load(open('docs/research/codex-model-catalog.json'))['models']
for m in d:
    print(m.get('slug'), '|', m.get('display_name'), '| keys:', sorted(m.keys()))
"
gpt-6-astra | GPT-6-Astra | keys: ['additional_speed_tiers', 'apply_patch_tool_type', 'availability_nux', 'base_instructions', 'comp_hash', 'context_window', 'default_reasoning_level', 'default_reasoning_summary', 'default_service_tier', 'default_verbosity', 'description', 'display_name', 'effective_context_window_percent', 'experimental_supported_tools', 'include_apps_usage_instructions', 'include_plugin_usage_instructions', 'include_skills_usage_instructions', 'input_modalities', 'max_context_window', 'model_messages', 'multi_agent_reasoning_effort', 'multi_agent_version', 'node_repl_auto_review_required', 'node_repl_disabled', 'priority', 'service_tiers', 'shell_type', 'slug', 'support_verbosity', 'supported_in_api', 'supported_reasoning_levels', 'supports_experimental_context', 'supports_image_detail_original', 'supports_search_tool', 'tool_mode', 'truncation_policy', 'upgrade', 'use_responses_lite', 'visibility', 'web_search_tool_type']
gpt-reserve | GPT-Reserve | keys: ['additional_speed_tiers', 'apply_patch_tool_type', 'availability_nux', 'base_instructions', 'comp_hash', 'context_window', 'default_reasoning_level', 'default_reasoning_summary', 'default_service_tier', 'default_verbosity', 'description', 'display_name', 'effective_context_window_percent', 'experimental_supported_tools', 'include_apps_usage_instructions', 'include_plugin_usage_instructions', 'include_skills_usage_instructions', 'input_modalities', 'max_context_window', 'model_messages', 'multi_agent_version', 'node_repl_auto_review_required', 'node_repl_disabled', 'priority', 'service_tiers', 'shell_type', 'slug', 'support_verbosity', 'supported_in_api', 'supported_reasoning_levels', 'supports_experimental_context', 'supports_image_detail_original', 'supports_search_tool', 'tool_mode', 'truncation_policy', 'upgrade', 'use_responses_lite', 'visibility', 'web_search_tool_type']
gpt-5.6-sol | GPT-5.6-Sol | keys: ['additional_speed_tiers', 'apply_patch_tool_type', 'availability_nux', 'base_instructions', 'comp_hash', 'context_window', 'default_reasoning_level', 'default_reasoning_summary', 'default_service_tier', 'default_verbosity', 'description', 'display_name', 'effective_context_window_percent', 'experimental_supported_tools', 'include_apps_usage_instructions', 'include_plugin_usage_instructions', 'include_skills_usage_instructions', 'input_modalities', 'max_context_window', 'model_messages', 'multi_agent_version', 'node_repl_auto_review_required', 'node_repl_disabled', 'priority', 'service_tiers', 'shell_type', 'slug', 'support_verbosity', 'supported_in_api', 'supported_reasoning_levels', 'supports_experimental_context', 'supports_image_detail_original', 'supports_search_tool', 'tool_mode', 'truncation_policy', 'upgrade', 'use_responses_lite', 'visibility', 'web_search_tool_type']
gpt-5.6-terra | GPT-5.6-Terra | keys: ['additional_speed_tiers', 'apply_patch_tool_type', 'availability_nux', 'base_instructions', 'comp_hash', 'context_window', 'default_reasoning_level', 'default_reasoning_summary', 'default_service_tier', 'default_verbosity', 'description', 'display_name', 'effective_context_window_percent', 'experimental_supported_tools', 'include_apps_usage_instructions', 'include_plugin_usage_instructions', 'include_skills_usage_instructions', 'input_modalities', 'max_context_window', 'model_messages', 'multi_agent_version', 'node_repl_auto_review_required', 'node_repl_disabled', 'priority', 'service_tiers', 'shell_type', 'slug', 'support_verbosity', 'supported_in_api', 'supported_reasoning_levels', 'supports_experimental_context', 'supports_image_detail_original', 'supports_search_tool', 'tool_mode', 'truncation_policy', 'upgrade', 'use_responses_lite', 'visibility', 'web_search_tool_type']
gpt-5.6-luna | GPT-5.6-Luna | keys: ['additional_speed_tiers', 'apply_patch_tool_type', 'availability_nux', 'base_instructions', 'comp_hash', 'context_window', 'default_reasoning_level', 'default_reasoning_summary', 'default_service_tier', 'default_verbosity', 'description', 'display_name', 'effective_context_window_percent', 'experimental_supported_tools', 'include_apps_usage_instructions', 'include_plugin_usage_instructions', 'include_skills_usage_instructions', 'input_modalities', 'max_context_window', 'model_messages', 'multi_agent_version', 'node_repl_auto_review_required', 'node_repl_disabled', 'priority', 'service_tiers', 'shell_type', 'slug', 'support_verbosity', 'supported_in_api', 'supported_reasoning_levels', 'supports_experimental_context', 'supports_image_detail_original', 'supports_search_tool', 'tool_mode', 'truncation_policy', 'upgrade', 'use_responses_lite', 'visibility', 'web_search_tool_type']
gpt-5.5 | GPT-5.5 | keys: ['additional_speed_tiers', 'apply_patch_tool_type', 'availability_nux', 'base_instructions', 'comp_hash', 'context_window', 'default_reasoning_level', 'default_reasoning_summary', 'default_service_tier', 'default_verbosity', 'description', 'display_name', 'effective_context_window_percent', 'experimental_supported_tools', 'include_apps_usage_instructions', 'include_plugin_usage_instructions', 'include_skills_usage_instructions', 'input_modalities', 'max_context_window', 'model_messages', 'node_repl_auto_review_required', 'node_repl_disabled', 'priority', 'service_tiers', 'shell_type', 'slug', 'support_verbosity', 'supported_in_api', 'supported_reasoning_levels', 'supports_experimental_context', 'supports_image_detail_original', 'supports_search_tool', 'truncation_policy', 'upgrade', 'use_responses_lite', 'visibility', 'web_search_tool_type']
codex-auto-review | Codex Auto Review | keys: ['additional_speed_tiers', 'apply_patch_tool_type', 'availability_nux', 'base_instructions', 'comp_hash', 'context_window', 'default_reasoning_level', 'default_reasoning_summary', 'default_service_tier', 'default_verbosity', 'description', 'display_name', 'effective_context_window_percent', 'experimental_supported_tools', 'include_apps_usage_instructions', 'include_plugin_usage_instructions', 'include_skills_usage_instructions', 'input_modalities', 'max_context_window', 'model_messages', 'multi_agent_version', 'node_repl_auto_review_required', 'node_repl_disabled', 'priority', 'service_tiers', 'shell_type', 'slug', 'support_verbosity', 'supported_in_api', 'supported_reasoning_levels', 'supports_experimental_context', 'supports_image_detail_original', 'supports_search_tool', 'tool_mode', 'truncation_policy', 'upgrade', 'use_responses_lite', 'visibility', 'web_search_tool_type']
[0m
[0m$ [0mcodex --help 2>&1 | head -30; echo "=== app-server ==="; codex app-server --help 2>&1 | head -20
Codex CLI

If no subcommand is specified, options will be forwarded to the interactive CLI.

Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]

Commands:
  agents            Browse all agent sessions on the shared local app-server daemon
  exec              Run Codex non-interactively [aliases: e]
  review            Run a code review non-interactively
  login             Manage login
  logout            Remove stored authentication credentials
  mcp               Manage external MCP servers for Codex
  plugin            Manage Codex plugins
  app-server        [experimental] Run the app server or related tooling
  remote-control    [experimental] Manage the app-server daemon with remote control enabled
  app               Launch the Desktop app (opens the app installer if missing)
  completion        Generate shell completion scripts
  update            Update Codex to the latest version
  doctor            Diagnose local Codex installation, config, auth, and runtime health
  sandbox           Run commands within a Codex-provided sandbox
  debug             Debugging tools
  apply             Apply the latest diff produced by Codex agent as a `git apply` to your local
                    working tree [aliases: a]
  resume            Resume a previous interactive session (picker by default; use --last to continue
                    the most recent)
  queue             Queue a message for an existing session
  archive           Archive a saved session by id or session name
  delete            Permanently delete a saved session by id or session name
=== app-server ===
[experimental] Run the app server or related tooling

Usage: codex app-server [OPTIONS] [COMMAND]

Commands:
  daemon                Manage the local app-server daemon
  proxy                 Proxy stdio bytes to the running app-server control socket
  generate-ts           [experimental] Generate TypeScript bindings for the app server protocol
  generate-json-schema  [experimental] Generate JSON Schema for the app server protocol
  help                  Print this message or the help of the given subcommand(s)

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.
          
          Examples: - `-c model="o3"` - `-c 'sandbox_permissions=["disk-full-read-access"]'` - `-c
          shell_environment_policy.inherit=all`
[0m
[0m$ [0mpython3 -c "
import json
d=json.load(open('docs/research/codex-model-catalog.json'))['models']
for m in d:
    print(m['slug'], 'ctx=',m.get('context_window'), 'max=',m.get('max_context_window'), 'eff%=',m.get('effective_context_window_percent'), 'vis=',m.get('visibility'), 'api=',m.get('supported_in_api'))
"
gpt-6-astra ctx= 272000 max= 872000 eff%= 95 vis= list api= True
gpt-reserve ctx= 272000 max= 872000 eff%= 95 vis= hide api= True
gpt-5.6-sol ctx= 272000 max= 872000 eff%= 95 vis= list api= True
gpt-5.6-terra ctx= 272000 max= 872000 eff%= 95 vis= list api= True
gpt-5.6-luna ctx= 272000 max= 872000 eff%= 95 vis= list api= True
gpt-5.5 ctx= 272000 max= 272000 eff%= 95 vis= list api= True
codex-auto-review ctx= 272000 max= 872000 eff%= 95 vis= hide api= True
[0m
[0m$ [0m/usr/local/bin/node --version 2>/dev/null; ~/.hermes/node/bin/node --version 2>/dev/null; ls ~/.nvm/versions/node 2>/dev/null; echo "=== app-server bare ==="; codex app-server --help 2>&1 | tail -30
v24.11.1
v22.23.1
v22.22.2
v24.14.0
=== app-server bare ===
          
          ```toml [analytics] enabled = false ```
          
          See https://developers.openai.com/codex/config-advanced/#metrics for more details.

      --ws-auth <MODE>
          Websocket auth mode for non-loopback listeners
          
          [possible values: capability-token, signed-bearer-token]

      --ws-token-file <PATH>
          Absolute path to the capability-token file

      --ws-token-sha256 <HEX>
          Hex-encoded SHA-256 digest of the capability token

      --ws-shared-secret-file <PATH>
          Absolute path to the shared secret file for signed JWT bearer tokens

      --ws-issuer <ISSUER>
          Expected issuer for signed JWT bearer tokens

      --ws-audience <AUDIENCE>
          Expected audience for signed JWT bearer tokens

      --ws-max-clock-skew-seconds <SECONDS>
          Maximum clock skew when validating signed JWT bearer tokens

  -h, --help
          Print help (see a summary with '-h')
[0m
[0m$ [0mls scripts; echo ---; command -v microsandbox msb just-bash; ls ~/.local/bin | head -30; echo ---; ls ~/Library/Application\ Support/msb 2>/dev/null | head -3; echo "---npm global---"; npm ls -g --depth=0 2>/dev/null | head -20
run-counsel.sh
---
agent
aside
camo-studio
ccg
cf-wrangler
claude
claude-grok
cmux
cmux-dev
codex
cua-driver
cursor
cursor-agent
devin
drive-admin
dsh
grok
hermes
hermes-acp
jobcenter-agent
main-agent
node
npm
npx
opencode2
posthog-cli
python3.11
tabari-acp
wrangler
wrangler2
---
---npm global---
/Users/wasimjalali/.local/lib
├── @deepseek-ai/dsh@0.1.2-rc.1
├── @openai/codex@0.154.0
├── @opencode-ai/cli@0.0.0-beta-19271
├── @posthog/cli@0.11.1
└── wrangler@4.119.0
[0m
## Verdict
Sound with changes: the layering is right, but two "verified" facts in section 2 are false on this machine and the build order contradicts the fixed macOS-first priority.

## Critical
- [§2 evidence table, Phase 0 S1] Node is not 24 on the default PATH. `which -a node` resolves `~/.local/bin/node` = v22.23.1 first; `/usr/local/bin/node` = v24.11.1, `~/.hermes/node/bin/node` = v22.23.1, nvm has 22.22.2 and 24.14.0. eve requires Node 24+, so `npm run dev` from Wasim's shell fails at S1. Fix: `.nvmrc` + `engines.node >=24`, absolute interpreter in the run scripts, and a boot assertion in `agent/agent.ts` dev path that prints `process.version`.
- [D9, S5] `microsandbox` is not installed (no `microsandbox`/`msb` in PATH or `~/.local/bin`). Docker is absent too, so eve's real local backend is `just-bash`, which is not OS-level isolation. The plan then ships `bash` + `write_file` to an agent. Fix: S5 must record which backend actually resolves; if it is just-bash, treat the agent as unsandboxed and require approval gates on `bash`/`write_file` (currently only "destructive tools" in 2.7).
- [§3 secret discipline, D1, 3.3] The loopback router is not a security boundary against the agent. The agent holds the router bearer token, so a prompt-injected turn can use the router as an oracle and drain subscription quota; worse, the Next.js chat reachable over Tailscale is an agent with `bash` on the host, and `localDev()` plus one shared bearer makes any tailnet peer a shell. Fix: per-caller tokens with per-token alias allowlists and spend caps, Tailscale ACL to one device, a reduced-tool (no `bash`) channel for phone traffic, and explicit bind address.
- [D7 vs §1/§6] Fixed priority is macOS first; the plan puts the macOS app in Phase 5 behind web UI, evals and two weeks of use. Fix: either restate the priority or design `agent/channels/web/**` for WKWebView from 3.2 (no browser-only APIs, fixed viewport, deep-link session ids) and ship 5.1 as a thin wrapper right after 3.1.
- I could not verify eve's behaviour locally: the repo has no `package.json`/`node_modules`, eve is not in the global npm list. All eve claims below are taken from the plan, not checked.

## High
- [D3, 1.4, S4] `codex app-server` is the Codex *agent* protocol (threads, turns, approvals, `apply_patch`, cwd, sandbox), marked experimental, and its catalog injects `base_instructions` and `model_messages.persistent_instructions` per model. It is not a drop-in OpenAI-equivalent: our `instructions.md` lands underneath Codex's system prompt, and it also supports WS listeners (`--ws-auth capability-token`) plus a shared daemon with `proxy`. Fix: run `codex app-server generate-json-schema` (and `generate-ts`), commit the schema, pin it in `router/src/upstreams/codex.ts`, spike "does our system prompt win", and serialize turns (one active turn per thread) in the adapter.
- [R3, 1.2, 1.7] The catalog already carries windows: `context_window` 272000, `max_context_window` 872000, `effective_context_window_percent` 95 for every listed model, so the usable number is 258400, not 272000. `gpt-reserve` and `codex-auto-review` are `visibility: hide` and must not be registry aliases. Fix: registry records effective window + source + date, and refuses to boot on an unknown window, not just an unknown alias.
- [1.1, 1.4, R6] No 429/streaming semantics. Once SSE headers are flushed you cannot retry or fall back. Fix: pre-flight quota/capability probe per alias, fallback decided before the first byte, per-upstream circuit breaker, and a documented error shape for mid-stream failure.
- [§4, D2] The router is a single point of failure with no supervisor or startup order (eve boots before the router and every turn 503s). Fix: launchd keepalive, `/health` gating, and a dependency check in `agent.ts`. D2 is also unfalsifiable: it promises "proven translators where they earn it" and names none, then D4 rejects `opencode serve`. Delete D2 or name the component.
- [2.4, D8] `~/.useful-bot/memory/*.md` with no format, index or eviction spec; also no backup and the repo has no remote and no commits despite the branch-discipline law in 2.2.

## Answers to the plan's open questions
1. One process, one port, adapters as modules. Split only the Codex path, and only as a child process, because it is the one with crash-prone stdio state. Per-subscription services multiply ports, tokens and fallback logic for no gain.
2. `codex app-server`, attached as a long-lived client (its `daemon`/`proxy` model), not a spawn per turn and not `codex exec`. `codex exec` re-auths and loses thread continuity per turn. Verify with `generate-json-schema` first; it is experimental and injects its own instructions.
3. Markdown files as truth plus a SQLite FTS5 index at `~/.useful-bot/memory/index.db`. `defineState` is session-scoped per the plan, so it cannot carry cross-session memory. At 10k notes the disk and grep are fine; what breaks is context. Fix with tiers (index, daily digest, full note) and a hard token cap on injected memories.
4. Pin per subagent. Step-level switching destroys the prefix cache, breaks tool-call continuity mid-turn, and makes mid-turn fallback unsafe. Keep alias-to-upstream sticky per session so caches stay warm.
5. One upstream (OpenCode Go), two aliases (workhorse + reviewer), `instructions.md`, `bash`/`read_file`/`write_file`/`web_fetch`, the memory tool, and either `eve dev` or the web page. Cut: Codex adapter, subagents, MCP, schedules, skill porting, design pass, macOS wrapper. Test: five named daily tasks for seven days.
6. D7 is wrong (build order inverts the stated priority), D9 rests on uninstalled software, D2 is unfalsifiable, and D5's step-level selection fights prompt caches (see 4). D1, D3, D4, D6, D8 are defensible.

## What the plan is missing entirely
- Observability and spend accounting: no trace id linking eve trace to router request to upstream, no per-subscription usage counters. Consequence: no answer to "which alias burned the quota" or "why did it choose that model", and R6 stays invisible.
- A cutover test from Hermes: the plan never lists what Hermes does today that v1 must match (channels, schedules, skills), so 4.2 ("Wasim's verdict") has no acceptance criteria.
- Deprecation handling: model ids leave subscriptions (32 OpenCode ids today). The registry validates at boot but nothing covers a runtime 404 or an alias silently downgraded.

## The one change that most improves this plan
Replace the section 2 evidence table with a committed recon script plus output (`docs/research/recon.sh`, `recon.md`) that prints `node -v` per PATH entry, `command -v docker microsandbox`, the `codex app-server` JSON-schema hash, the Codex effective windows, and one live non-streaming call per upstream, and make every Phase 0 gate read from it. Two of the plan's "verified" facts are already false and one window number is wrong by 13,600 tokens; this converts the plan's foundation from recollection into a re-runnable check.
