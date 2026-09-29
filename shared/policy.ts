export type Alias = "workhorse" | "reviewer" | "image";
export type Profile = "desktop" | "phone" | "reviewer" | "eval";
export type SandboxBackendName = "microsandbox" | "docker" | "just-bash";
export type Isolation = "verified-vm" | "non-vm";

export const POLICY_WINDOW_TOKENS = 131_072;
export const POLICY_OUTPUT_TOKENS = 4_096;
export const POLICY_APPROVAL_TTL_MS = 5 * 60 * 1000;
export const POLICY_NODE_MAJOR = 24;
export const POLICY_EVE_VERSION = "0.54.3";
export const ABSOLUTE_NODE = "/usr/local/bin/node";
export const ROUTER_HOST = "127.0.0.1";
export const ROUTER_PORT = 4319;
export const EVE_HOST = "127.0.0.1";
export const EVE_PORT = 4321;
export const BODY_LIMIT_BYTES = 1_048_576;
/**
 * A completion body carries the conversation, and a conversation with images
 * in it carries their base64. Five 1 MiB attachments come to ~7 MB encoded,
 * so this route gets its own cap; every other route keeps the 1 MiB one.
 */
export const COMPLETION_BODY_LIMIT_BYTES = 8 * 1_048_576;
export const WRITE_MAX_BYTES = 64 * 1024;
export const READ_MAX_BYTES = 16 * 1024;

export const CALLER_LIMITS = {
  // Owner decision 2026-09-15: every bot shares the desktop caller, so its day
  // is sized for a whole team, not one chat. OpenCode Go's own fair-use limit
  // is the real ceiling above this.
  //
  // The request numbers are sized for ten bots working at once (2026-09-17). A
  // working bot makes a model call about every ten seconds (a step is the model
  // plus the tool it asked for), so 6 a minute; ten bots make 60. A day of
  // 10 bots x 50 turns x 8 steps is 4,000. The daily TOKEN budgets beside them
  // are unchanged: they are the spend guard, and the owner sets them in
  // Settings.
  desktop: { aliases: ["workhorse", "image"], search: true, rpm: 60, requests24h: 4_000, input24h: 30_000_000, output24h: 3_000_000 },
  // The phone profile is the owner's own phone, with the desktop budget
  // verbatim (spec S1): there is one owner inference budget, and which device
  // sent the turn does not change it.
  phone: { aliases: ["workhorse", "image"], search: true, rpm: 60, requests24h: 4_000, input24h: 30_000_000, output24h: 3_000_000 },
  reviewer: { aliases: ["reviewer"], search: false, rpm: 4, requests24h: 20, input24h: 300_000, output24h: 80_000 },
  eval: { aliases: ["workhorse", "reviewer", "image"], search: true, rpm: 12, requests24h: 80, input24h: 1_000_000, output24h: 160_000 },
  ops: { aliases: [], search: false, rpm: 30, requests24h: 0, input24h: 0, output24h: 0 },
} as const;

// Aggregate ceiling shared by every model caller, not a subscription entitlement.
// The request count keeps its old 500 of headroom over the desktop caller for
// the reviewer, eval and phone callers.
export const AGGREGATE_LIMITS = {
  requests24h: 4_500,
  input24h: 32_000_000,
  output24h: 3_500_000,
} as const;

// Search caps from SPEC.md section 7: per-caller daily budgets, the aggregate
// daily ceiling, and at most one search per second per caller.
export const SEARCH_LIMITS = {
  desktop: 50,
  phone: 10,
  eval: 20,
  aggregate: 60,
  minIntervalMs: 1000,
} as const;

// Model calls in flight across the router. One per session is the other half
// of the rule and is not a number: see router/src/concurrency.ts. Ten is the
// owner's rollout figure; the eleventh gets a retryable 429.
export const MAX_ACTIVE_UPSTREAM = 10;
// Searches in flight. Its own gate, so a search never holds a completion slot.
// The provider allows about one search a second, so four is already generous.
export const MAX_ACTIVE_SEARCH = 4;
// Image generations in flight. Its own gate too: a minute-long image call
// must never hold the completion slot a bot's next step is waiting on.
export const MAX_ACTIVE_IMAGE = 4;

/**
 * A count, like `MAX_TOOL_SCHEMAS` below, and not the real bound either:
 * `COMPLETION_BODY_LIMIT_BYTES` is what keeps the upstream payload sane, and
 * eve compacts a session at 90% of the model's window long before a
 * conversation of this length is a problem for anyone.
 *
 * It was 256, which a bot doing real work walks through in an afternoon: every
 * step adds an assistant message and a tool result, so a few hours of filing
 * documents is a few hundred messages. Crossing it threw `unsupported_parameter`,
 * a non-retryable 400, and eve retires a session that gets one: the chat was
 * dead for good and the owner's only way on was a fresh one. It happened twice
 * in two days (2026-09-19, and to Drive Admin mid-task on 2026-09-20). The cap
 * is here to stop a runaway caller, not to end a long conversation.
 */
export const MAX_MESSAGE_COUNT = 4_096;
/**
 * A count, not the real bound: `MAX_TOOL_SCHEMA_BYTES` is what keeps the
 * upstream payload sane, and a schema's size has little to do with how many
 * there are. 32 was one below what this app actually sends (26 agent tools
 * plus eve's own, 33 in total on 2026-09-15), so adding a single tool killed
 * every turn with `unsupported_parameter`. The headroom here is for the
 * connector and per-session tools a bot picks up, which vary per roster;
 * the byte bound below is what actually protects the upstream.
 */
export const MAX_TOOL_SCHEMAS = 300;
export const MAX_TOOL_SCHEMA_BYTES = 128 * 1024;

/**
 * The cap above is a wall, not a budget: the router refuses a turn past it
 * with a non-retryable `unsupported_parameter`, and eve retires a session
 * that gets one, so the chat is dead for good. Nothing may be allowed to walk
 * a bot into it. These three keep the running total well underneath.
 *
 * `MOUNTED_TOOL_BUDGET` is what a connect may take the eagerly mounted total
 * to. The rest of the headroom is for the agent's own tools, eve's, and the
 * tools a session picks up mid-turn.
 */
export const MOUNTED_TOOL_BUDGET = 60;
/**
 * And the same budget in bytes, because the router refuses a turn on schema
 * bytes too, with the same non-retryable error. Only what this app can
 * measure is counted: the argument schemas a connected MCP server published.
 * eve generates an OpenAPI connection's schemas itself and this side never
 * sees them, which is the other half of why the count budget is as low as it
 * is.
 */
export const MOUNTED_TOOL_BYTE_BUDGET = 24 * 1024;
/**
 * Tools one session may pick up on demand. Past this the model is told to
 * work with what it has rather than quietly walking the turn into the wall.
 */
export const MAX_SESSION_TOOLS = 40;
/**
 * And in bytes, for the same reason the mounted set has one: forty schemas
 * at the size a server is allowed to publish would clear the router's byte
 * wall on their own, and that refusal retires the session.
 */
export const MAX_SESSION_TOOL_BYTES = 40 * 1024;

export const FORBIDDEN_PATH_SUBSTRINGS = [
  ".env",
  "secrets",
  ".ssh",
  ".aws",
  ".gnupg",
  ".git",
  "LaunchAgents",
  "auth.json",
  // The same store under its other name, which Claude Code uses.
  ".credentials.json",
  // Credential stores that sit under a home directory a grant may cover.
  // read_file is ungated, so a folder grant on $HOME would otherwise hand
  // these over with no approval card. The list cannot be exhaustive, which is
  // why granting a home directory is a bad idea rather than a safe one; it
  // covers what is both common and unambiguous. A file a project legitimately
  // needs is still reachable through bash, which always shows a card.
  // These earn a substring rule because the real files are named around them
  // (`.env.local`, `id_rsa.pub`). Credential stores with one exact name are on
  // FORBIDDEN_CHILD_SEGMENTS instead, so `.dockerignore` is not read as
  // `.docker`.
  "keychain",
  "netrc",
  ".npmrc",
  ".pypirc",
  ".authinfo",
  // `.kubeconfig` holds cluster credentials as surely as `.kube/config`, so
  // this one wants the substring. `.docker` is the exception that forced the
  // segment screen: `.dockerignore` is not a credential store.
  ".kube",
  // `.docker/` with the slash names the store and not `.dockerignore`, so a
  // shell line spelling the path in full is refused everywhere.
  ".docker/",
  // Fish reads every file under here at startup; a planted one runs in the
  // owner's own shell, the way a planted `.zshrc` line would.
  ".config/fish",
  "library/cookies",
  "id_rsa",
  "id_ecdsa",
  "id_ed25519",
] as const;
