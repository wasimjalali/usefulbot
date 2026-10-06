# Why "Sign in with ChatGPT" (open-source flow) lists fewer models than the ChatGPT app

Research date: 2026-10-06. Research only: no OpenAI API call was made, no credential read, repo not edited.

Access notes: help.openai.com and openai.com return HTTP 403 to my fetchers (curl with a browser user agent too), so
the help articles (20001410, 20001542, 8411955), the ChatGPT release notes, the "Introducing GPT-6.1 Sol" post and the
Sign in with ChatGPT Terms are cited from search-engine snippets only and marked [snippet]. developers.openai.com
and learn.chatgpt.com (the new home of the Codex docs; developers.openai.com/codex/* 308-redirects there) load fine and
are the primary sources. Raw copies saved beside this file: siwc-full.txt (all SIWC docs, fetched 2026-10-06 from
https://developers.openai.com/siwc/llms-full.txt), models.txt (https://learn.chatgpt.com/docs/models.md),
wma.txt (https://learn.chatgpt.com/docs/enterprise/workspace-model-availability.md).

## Short answer

Two candidate causes. Neither is proven without a live call, which I was told not to make.

A. (Most likely, my estimate about 60 percent) The `GET /v1/models` request carries no `client_version`, and the catalog is
   gated by client version. OpenAI's own Codex client always appends `?client_version=<its version>` to the models call,
   including when it is pointed at `https://api.openai.com/v1` with a custom provider (the exact configuration OpenAI's
   SIWC docs tell Codex app-server users to use). Another open-source app showed that the same token returns
   `gpt-6.1-sol` with `client_version=0.159.3` and omits it with `0.158.0`. Three other apps that call the endpoint with no
   `client_version` (T3 Code, OpenCode, Useful Bot) all report the same three missing slugs
   (gpt-6.1-sol, gpt-6-sol, gpt-6-luna) while gpt-6-astra and gpt-5.6-* appear. Astra shipping earlier than Sol/Luna fits "older
   default client version sees older models".

B. (About 30 percent) Workspace binding. Per OpenAI, each issued `client_id` is bound to the user AND the workspace
   chosen at registration, and the docs say the plan-usage option is for Plus and Pro. If the owner registered Useful Bot
   under a different workspace than the one in his ChatGPT screenshot (the screenshot footer "Workspace data isn't used
   to train models" is a workspace-account string), the list reflects that workspace. Documented: in Enterprise and Edu,
   GPT-6 Sol, GPT-6 Luna and GPT-6.1 Sol are OFF by default until an admin enables them, and "selecting a model in
   local configuration doesn't grant access". The owner's list shows Astra but not Sol/Luna, which is a odd mix for a
   workspace (Astra is also off by default in Enterprise), so B alone explains it less well than A.

C. (Remainder) A server-side allowlist or rollout stage that hides these models from third-party (dynamic_agent_client) tokens.
   No OpenAI document says this. Cannot be excluded.

## 1. Which models per plan, and is a subset documented for third-party subscription sharing?

Documented (primary):
- Eligibility: "Eligible ChatGPT Plus and Pro users can use their ChatGPT plan for AI requests in your product."
  https://developers.openai.com/siwc/token-sharing-open-source (table row, also in quickstart). Fetched 2026-10-06.
  Same on https://learn.chatgpt.com/docs/sign-in-with-chatgpt.md ("eligible ChatGPT Plus and Pro subscribers").
- Help center [snippet, 403 on fetch], https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt and
  .../20001542-using-your-chatgpt-plan-in-other-apps-and-sites: "the option to use your ChatGPT plan is only available with
  Plus and Pro"; sign-in itself works for Enterprise users.
- Models page says nothing about a third-party subset. The SIWC models page only says: list models with
  `GET https://api.openai.com/v1/models`, keep `visibility == "list"`, "Refresh these choices when the user switches ChatGPT
  accounts", and "Use a model available to the signed-in account."
  https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- The Codex app-server page: `model/list` "can return a bundled client catalog. Treat it as a catalog, not an entitlement check;
  a successfully completed inference turn verifies access to the selected model for that request." (same llms-full.txt,
  "Codex app-server" section).
- Preview limitations list unsupported request fields and tools only; no model exclusions.
  https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- Codex model availability (GPT-6.1 Sol): "Launch rollout includes Plus, Pro, Business, Enterprise, and Edu in Codex in the desktop
  app and CLI, and ChatGPT Work on the web and mobile. For Enterprise and Edu, the plan keeps GPT-6.1 Sol off by default
  until an administrator enables it. Free and Go are not included at launch." https://learn.chatgpt.com/docs/models
  (fetched 2026-10-06). The surfaces named are Codex desktop/CLI and ChatGPT Work. Open-source SIWC clients are not named.
- "Availability depends on the rollout, your sign-in method, and your client." same page.

Not documented: a per-plan table for the SIWC route, a statement that newer models are excluded from it, or a per-model opt-in.

## 2. Are GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna Codex/Work-only, Pro-only, region-limited?

- "In ChatGPT, GPT-6.1 Sol, GPT-6 Sol, and GPT-6 Luna are available in Work and Codex. They aren't available in Chat."
  https://learn.chatgpt.com/docs/models (2026-10-06). So the ChatGPT-app "Work" tab is the right place to see them, and they
  are surface-gated: Work and Codex.
- GPT-6 Sol and Luna: launched 2026-09-22 for "Plus, Pro, Business, Enterprise, Edu" in Work and Codex; Free and Go get Luna in
  the desktop app only; "Enterprise: administrators must manually enable the new models" (9to5Mac, fetched via summary,
  https://9to5mac.com/2026/09/22/openai-upgrading-chatgpt-and-codex-with-two-more-gpt-6-models/ ; secondary source).
- GPT-6.1 Sol: launched 2026-09-29; OpenAI post on X: "available starting today to all Plus, Pro, Business, Enterprise, and Edu
  users in ChatGPT Work and Codex" (https://x.com/OpenAI/status/2104986136745767160, via TechCrunch
  https://techcrunch.com/2026/09/29/openai-launches-gpt-6-1-sol-says-it-nearly-matches-gpt-6-astra-and-costs-less/).
  One search snippet said rollout starts with Pro then expands [snippet, openai.com 403]. Treat the rollout order as unconfirmed.
- Enterprise admin gating (primary): "GPT-6 Sol and GPT-6 Luna are off by default in Enterprise workspaces at launch. An administrator
  must enable each model" and the same for GPT-6.1 Sol (Enterprise and Edu) and Astra. "Choosing a model in local configuration
  doesn't override workspace controls." https://learn.chatgpt.com/docs/enterprise/workspace-model-availability
  Business is not named in these sections.
- Region: the SIWC errors page says a 403 from direct admission can be "the permitted serving region". No model is documented as
  region-limited.
- API availability: gpt-6.1-sol, gpt-6-luna and others are listed with "API Access: true" on the Codex models page, and OpenAI's own
  SIWC example calls `gpt-6.1-sol` (models-and-inference, curl and Python examples). So the model is intended to work on this route
  for an entitled account.
- GPT-5.5 retires from ChatGPT, Work and Codex on 2026-10-14 (API unaffected). The owner's list still has `gpt-5.5` hidden.

## 3. Any parameter, scope, header, registration setting or admin setting that unlocks more? Does the list differ by workspace?

- Scope: the documented scope set is `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, resource
  `https://api.openai.com/v1`. No documented extra scope for models. (sign-in page in llms-full.txt)
- Headers: the docs show only `Authorization: Bearer`. No ChatGPT-Account-Id or workspace header is documented for this route.
  The docs also say "do not point it at ChatGPT's backend-api endpoints."
- Workspace: "each issued client_id is bound to the authenticated user and the workspace selected during registration"
  (token-sharing-open-source). On reauthorization "The client stays bound to its registered workspace", and `id_token_hint` "does not
  change the workspace bound to this client". The sign-in page also says users may "add another account or workspace". So the list can
  differ by workspace, and the only documented way to change workspace is a fresh dynamic registration (`client_id=dynamic_agent_client`)
  choosing the other workspace. Email and `sub` are not workspace identifiers.
- Admin setting (documented): Enterprise and Edu admins enable each GPT-6 model in workspace model settings (help article 8411955,
  not fetchable). Per the plan docs, Plus accounts need no such step.
- `client_version` query parameter (NOT documented in the SIWC docs; grep count 0 in siwc-full.txt) but used by the official client:
  - openai/codex `codex-rs/codex-api/src/endpoint/models.rs`: `append_client_version_query` adds `client_version=<ver>` to every
    models request. `codex-rs/model-provider/src/models_endpoint.rs` ("Provider-owned OpenAI-compatible /models endpoint") calls
    `ModelsClient::request_url(&api_provider, client_version)` for a custom provider base URL, which is the SIWC configuration.
    https://github.com/openai/codex (read via gh api, 2026-10-06). The model record type carries `minimal_client_version`
    (test fixture `"minimal_client_version": [0, 1, 0]` in codex-rs/models-manager/src/manager_tests.rs).
  - openclaw/openclaw issue 162768, opened 2026-10-01: "The backend gates model availability by client_version". With the same ChatGPT
    token, `.../models?client_version=0.158.0` omits gpt-6.1-sol and `...=0.159.3` includes it
    (that report is about the Codex backend base URL, not api.openai.com/v1, so it is evidence for the mechanism, not proof for this exact host).
    https://github.com/openclaw/openclaw/issues/162768
  - The ChatGPT-Codex-route comment in Useful Bot's own `shared/provider-catalog.ts` line 30 says "The ChatGPT Codex list requires
    client_version". Commit cccaf10 moved ChatGPT sign-in to the official flow and the openai/oauth mode no longer sets
    `modelsQuery`, so today's call sends none.
- Codex app-server's `model/list` returns a bundled catalog and is not an entitlement check (docs quote above).

## 4. Do other open-source apps report the same gap? (all dates from GitHub, UTC)

- T3 Code, pingdotgg/t3code issue 14321, opened 2026-09-29, open: "Connect with ChatGPT omits Codex models available through CLI login".
  Same account email on both. CLI login lists 9 (gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol/terra/luna,
  gpt-daybreak-blue-latest, gpt-5.5). The SIWC token lists 6: gpt-6-astra, gpt-5.6-sol/terra/luna, gpt-daybreak-blue-latest, gpt-5.5.
  Missing exactly gpt-6.1-sol, gpt-6-sol, gpt-6-luna, identical to Useful Bot. Its loader calls `https://api.openai.com/v1/models`
  with only a bearer token and keeps `visibility === "list"` (source `apps/server/src/provider/CodexChatGptModels.ts`). Its native Codex
  cache (client_version 0.159.0) does contain the three. No OpenAI answer in the issue.
  https://github.com/pingdotgg/t3code/issues/14321
- OpenCode, anomalyco/opencode issue 52375, opened 2026-09-30, open: "gpt-6.1-sol missing from ChatGPT OAuth models". Plus account.
  The older Codex-backend path (CLI 2.0.10) lists and runs gpt-6.1-sol; the new token-sharing plugin (PR 52147, merged 2026-09-29)
  that rebuilds the list from `GET api.openai.com/v1/models` does not. Comments 2026-10-05: also gpt-6-luna vanished, and CLI 2.0.21 is
  affected. A reporter suspects a filter `visibility === "list" && supported_in_api`. No fix yet.
  https://github.com/anomalyco/opencode/issues/52375
- OpenClaw issue 155937, opened 2026-09-22: "Sol rejected despite OAuth discovery". Different cause (embedded runtime and
  client_version), and mentions the catalog version change made models list report Sol as available while execution still failed.
  https://github.com/openclaw/openclaw/issues/155937 . Issue 162768 above is the client_version one.
- Hermes Agent issue 130149 (2026-10-01): a stale cached catalog hid gpt-6-sol, gpt-6-luna and gpt-6.1-sol. That is a cache bug on
  the Codex-OAuth path, and it notes "Step 3 returns the full current list for the same exhausted token". Not the SIWC route.
  https://github.com/NousResearch/hermes-agent/issues/130149
- Cline, Pi, Kilo Code: searches for the slugs found nothing on this gap. OpenBot: not found on GitHub by search (not checked further).
- Nobody in these threads reports an OpenAI explanation, and none of them has tried `client_version` on api.openai.com/v1/models.

## 5. Calling a slug that is not in the list

- Allowed by documentation: "Use a model available to the signed-in account" and the Codex page says the catalog is "not an
  entitlement check; a successfully completed inference turn verifies access to the selected model". So an attempt is the documented
  verification method.
- Refusal path: a model the account cannot use is rejected. The documented code for an unsupported model is
  `subscription_sharing_unsupported_capability` (HTTP 400): "Inspect error.param and remove the unsupported input, tool, execution
  feature, model, or service-tier override. Do not retry the same invalid body."
  `subscription_sharing_user_not_eligible` (403) means plan usage is unavailable for the user, workspace or policy.
  https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
- Terms [snippet, https://openai.com/policies/sign-in-with-chatgpt-terms/ returned 403]: use your app's real name, do not impersonate OpenAI,
  another app or another open-source project, obtain tokens only through OpenAI's flow and as the user authorized, do not alter or
  reverse engineer the SIWC software. Nothing found about calling unlisted slugs. Impersonation is the relevant risk for any
  `client_version` value that claims to be the official Codex.

## What remains unknown

1. Whether `api.openai.com/v1/models` honors `client_version` for a SIWC token. Only the Codex-backend host is evidenced.
2. Which workspace the owner's Useful Bot client is bound to, and whether it is the Plus account or a Business workspace.
3. Whether gpt-6.1-sol, gpt-6-sol and gpt-6-luna would actually complete a turn on his token. Nobody has run the test publicly.
4. Whether OpenAI hides these three from dynamic_agent_client tokens on purpose (cause C). No statement found.
5. Business plan treatment: the admin-default-off text names Enterprise and Edu, not Business.
6. Help center articles and release notes were not readable, so any plan table there is unchecked.
