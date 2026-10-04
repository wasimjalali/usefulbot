import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, linkSync } from "node:fs";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { agentStorePath } from "../shared/agent-store.ts";
import { defaultShellPath } from "../shared/shell-io.ts";
import { defaultApprovalsPath } from "../agent/lib/approvals.ts";
import { defaultWorkspacePath } from "../shared/workspace-store.ts";
import { routinesStorePath } from "../shared/routines-store.ts";
import { defaultWebSessionsPath } from "../shared/web-sessions.ts";
import { handoffDir } from "../shared/handoffs.ts";
import { memoryRoot } from "../agent/lib/memory.ts";
import { widgetsDir } from "../shared/widgets-store.ts";
import { imagesDir } from "../shared/images-store.ts";
import { mediaIndexPath, mediaRoot } from "../shared/media-store.ts";
import { providersPath } from "../shared/providers.ts";
import { modelsCachePath } from "../shared/live-models.ts";
import { connectorsPath } from "../shared/connectors-store.ts";
import { connectionsPath } from "../shared/connections-store.ts";
import { connectionToolsPath } from "../shared/connection-tools-store.ts";
import { oauthPendingPath } from "../shared/mcp-oauth.ts";
import { providerPendingPath } from "../shared/provider-oauth.ts";
import { cataloguePath } from "../shared/composio-catalogue.ts";
import { limitsPath } from "../shared/limits-store.ts";
import { defaultOwnerPath } from "../agent/lib/session-owners.ts";
import { defaultSessionOwnersPath } from "../shared/session-bindings.ts";
import { connectionSecretService, keychainGet, keychainSet, memoryKeychain, setKeychainDriver } from "../shared/keychain.ts";
import { isForbiddenChildSegment, isGrantableRootPath } from "../shared/shell-store.ts";
import { assertSafeRoot, resolveWorkspacePath } from "../agent/lib/workspace.ts";
import { confinedCommand, PROTECTED_NAMES, sandboxAvailable, sandboxProfile } from "../agent/lib/sandbox.ts";
import { approvedWrite } from "../agent/lib/write.ts";
import readFile from "../agent/tools/read_file.ts";
import listDir from "../agent/tools/list_dir.ts";
import bash from "../agent/tools/bash.ts";
import {
  assertStack,
  eveOrigin,
  evePort,
  keychainName,
  keychainPrefix,
  keychainServiceAllowed,
  mentionsAppState,
  ORIGIN_OVERRIDE_VARS,
  routerApiBase,
  routerConfigPath,
  routerDbPath,
  routerOrigin,
  routerPort,
  stackName,
  stackProblems,
  stateRootLinkProblems,
  STORE_OVERRIDE_VARS,
  stateRoot,
  webOrigin,
  webPort,
} from "../shared/stack.ts";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));
const execFileAsync = promisify(execFile);
const darwin = process.platform === "darwin";

// Every variable the stack and the stores read. withEnv clears all of them,
// so a developer's own shell (or a UB_* left by another test) cannot leak in.
const STORE_OVERRIDES = [
  "UB_AGENT_STORE_PATH", "UB_SHELL_PATH", "UB_APPROVALS_PATH", "UB_WORKSPACE_STORE_PATH", "UB_ROUTINES_PATH",
  "UB_WEB_SESSIONS_PATH", "UB_HANDOFF_DIR", "UB_MEMORY_ROOT", "UB_WIDGETS_DIR", "UB_IMAGES_DIR",
  "UB_MEDIA_INDEX_PATH", "UB_PROVIDERS_PATH", "UB_MODELS_CACHE_PATH", "UB_CONNECTORS_PATH", "UB_CONNECTIONS_PATH",
  "UB_CONNECTION_TOOLS_PATH", "UB_OAUTH_PENDING_PATH", "UB_PROVIDER_OAUTH_PATH", "UB_CATALOGUE_PATH", "UB_LIMITS_PATH",
  "UB_SESSION_OWNERS_PATH", "UB_ROUTER_DB", "UB_ROUTER_CONFIG",
];
const STACK_VARS = [
  "UB_STACK", "UB_STATE_ROOT", "UB_ROUTER_PORT", "UB_WEB_PORT", "UB_EVE_PORT", "UB_KEYCHAIN_PREFIX", "UB_MEDIA_DIR",
  "UB_WEB_BASE_URL", "UB_ROUTER_BASE_URL", "UB_OPENCODE_GO_BASE", "UB_WORKSPACE_ROOT",
];
const ALL_VARS = ["HOME", "NODE_TEST_CONTEXT", ...STACK_VARS, ...STORE_OVERRIDES];

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map(ALL_VARS.map((key) => [key, process.env[key]] as const));
  for (const key of ALL_VARS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnvAsync<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(ALL_VARS.map((key) => [key, process.env[key]] as const));
  for (const key of ALL_VARS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const tempHome = () => mkdtempSync(join(tmpdir(), "ub-stack-"));

function devEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    UB_STACK: "dev",
    UB_STATE_ROOT: join(home, ".useful-bot-dev-app"),
    UB_ROUTER_PORT: "4419",
    UB_WEB_PORT: "4420",
    UB_EVE_PORT: "4421",
    UB_KEYCHAIN_PREFIX: "com.usefulbot.dev",
    UB_MEDIA_DIR: join(home, "Documents", "Useful Bot Dev"),
    UB_WEB_BASE_URL: "http://127.0.0.1:4420",
  };
}

// ---------------------------------------------------------------------------
// 1. Every store resolves under the state root, and its own override still wins.

const STORES: Array<{ name: string; path: () => string; tail: string; override: string | null }> = [
  { name: "agent-store", path: () => agentStorePath(), tail: "agents.json", override: "UB_AGENT_STORE_PATH" },
  { name: "shell-io", path: () => defaultShellPath(), tail: "shell.json", override: "UB_SHELL_PATH" },
  { name: "approvals", path: () => defaultApprovalsPath(), tail: "approvals.json", override: "UB_APPROVALS_PATH" },
  { name: "workspace-store", path: () => defaultWorkspacePath(), tail: "workspace.json", override: "UB_WORKSPACE_STORE_PATH" },
  { name: "routines-store", path: () => routinesStorePath(), tail: "routines.json", override: "UB_ROUTINES_PATH" },
  { name: "web-sessions", path: () => defaultWebSessionsPath(), tail: "web-sessions.json", override: "UB_WEB_SESSIONS_PATH" },
  { name: "handoffs", path: () => handoffDir(), tail: "handoffs", override: "UB_HANDOFF_DIR" },
  { name: "memory", path: () => memoryRoot(), tail: "memory", override: "UB_MEMORY_ROOT" },
  { name: "widgets-store", path: () => widgetsDir(), tail: "widgets", override: "UB_WIDGETS_DIR" },
  { name: "images-store", path: () => imagesDir(), tail: "images", override: "UB_IMAGES_DIR" },
  { name: "media-store index", path: () => mediaIndexPath(), tail: "media.json", override: "UB_MEDIA_INDEX_PATH" },
  { name: "providers", path: () => providersPath(), tail: "providers.json", override: "UB_PROVIDERS_PATH" },
  { name: "live-models", path: () => modelsCachePath(), tail: "models-cache.json", override: "UB_MODELS_CACHE_PATH" },
  { name: "connectors-store", path: () => connectorsPath(), tail: "connectors.json", override: "UB_CONNECTORS_PATH" },
  { name: "connections-store", path: () => connectionsPath(), tail: "connections.json", override: "UB_CONNECTIONS_PATH" },
  { name: "connection-tools-store", path: () => connectionToolsPath(), tail: "connection-tools.json", override: "UB_CONNECTION_TOOLS_PATH" },
  { name: "mcp-oauth", path: () => oauthPendingPath(), tail: "connections-oauth.json", override: "UB_OAUTH_PENDING_PATH" },
  { name: "provider-oauth", path: () => providerPendingPath(), tail: "provider-oauth.json", override: "UB_PROVIDER_OAUTH_PATH" },
  { name: "composio-catalogue", path: () => cataloguePath(), tail: "composio-catalogue.json", override: "UB_CATALOGUE_PATH" },
  { name: "limits-store", path: () => limitsPath(), tail: "limits.json", override: "UB_LIMITS_PATH" },
  { name: "session bindings", path: () => defaultSessionOwnersPath(), tail: "session-owners.json", override: "UB_SESSION_OWNERS_PATH" },
  { name: "router usage db", path: () => routerDbPath(), tail: "router/usage.sqlite", override: "UB_ROUTER_DB" },
  { name: "router config", path: () => routerConfigPath(), tail: "config.json", override: "UB_ROUTER_CONFIG" },
  { name: "session owners", path: () => defaultOwnerPath(), tail: "policy.sqlite", override: null },
];

test("with no stack setting every store sits under ~/.useful-bot (daily unchanged)", () => {
  const home = tempHome();
  try {
    withEnv({ HOME: home }, () => {
      for (const store of STORES) {
        assert.equal(store.path(), join(home, ".useful-bot", store.tail), store.name);
      }
      assert.equal(stateRoot(), join(home, ".useful-bot"));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("with UB_STATE_ROOT every store sits under it, not under ~/.useful-bot", () => {
  const home = tempHome();
  const root = join(home, "elsewhere");
  try {
    withEnv({ HOME: home, UB_STATE_ROOT: root }, () => {
      for (const store of STORES) {
        assert.equal(store.path(), join(root, store.tail), store.name);
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a store's own UB_*_PATH override beats UB_STATE_ROOT and the default", () => {
  const home = tempHome();
  try {
    for (const store of STORES) {
      if (!store.override) continue;
      const pinned = join(home, "pinned", store.tail);
      withEnv({ HOME: home, UB_STATE_ROOT: join(home, "elsewhere"), [store.override]: pinned }, () => {
        assert.equal(store.path(), pinned, `${store.name} with UB_STATE_ROOT`);
      });
      withEnv({ HOME: home, [store.override]: pinned }, () => {
        assert.equal(store.path(), pinned, `${store.name} without UB_STATE_ROOT`);
      });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the media folder keeps ~/Documents/Useful Bot by default and honours UB_MEDIA_DIR", () => {
  const home = tempHome();
  try {
    withEnv({ HOME: home }, () => {
      assert.equal(mediaRoot(), join(home, "Documents", "Useful Bot"));
    });
    withEnv({ HOME: home, UB_MEDIA_DIR: join(home, "Documents", "Useful Bot Dev") }, () => {
      assert.equal(mediaRoot(), join(home, "Documents", "Useful Bot Dev"));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Ports, prefix and origins default to today's values.

test("ports, prefix and origins default to the daily literals", () => {
  const home = tempHome();
  try {
    withEnv({ HOME: home }, () => {
      assert.equal(stackName(), "daily");
      assert.equal(routerPort(), 4319);
      assert.equal(webPort(), 4320);
      assert.equal(evePort(), 4321);
      assert.equal(keychainPrefix(), "com.usefulbot");
      assert.equal(keychainName("router.desktop"), "com.usefulbot.router.desktop");
      assert.equal(routerOrigin(), "http://127.0.0.1:4319");
      assert.equal(routerApiBase(), "http://127.0.0.1:4319/v1");
      assert.equal(eveOrigin(), "http://127.0.0.1:4321");
      assert.equal(webOrigin(), "http://127.0.0.1:4320");
      assert.deepEqual(stackProblems(), []);
    });
    withEnv({ HOME: home, UB_STACK: "daily" }, () => assert.equal(stackName(), "daily"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a port or base URL given in the environment is used; a bad port is refused", () => {
  withEnv({ UB_ROUTER_PORT: "5319", UB_WEB_PORT: "5320", UB_EVE_PORT: "5321" }, () => {
    assert.equal(routerPort(), 5319);
    assert.equal(webPort(), 5320);
    assert.equal(evePort(), 5321);
    assert.equal(routerApiBase(), "http://127.0.0.1:5319/v1");
    assert.equal(webOrigin(), "http://127.0.0.1:5320");
  });
  withEnv({ UB_ROUTER_BASE_URL: "http://127.0.0.1:9/v1" }, () => assert.equal(routerApiBase(), "http://127.0.0.1:9/v1"));
  withEnv({ UB_WEB_BASE_URL: "https://x.example" }, () => assert.equal(webOrigin(), "https://x.example"));
  for (const bad of ["abc", "0", "70000", "43.5", "-1"]) {
    withEnv({ UB_WEB_PORT: bad }, () => assert.throws(() => webPort(), /UB_WEB_PORT/, bad));
  }
  withEnv({ UB_STACK: "staging" }, () => assert.throws(() => stackName(), /UB_STACK/));
});

// ---------------------------------------------------------------------------
// 3. The dev stack fails loud and never falls back to a daily value.

test("a complete dev environment passes and resolves every value to its dev one", () => {
  const home = tempHome();
  try {
    withEnv(devEnv(home), () => {
      assert.deepEqual(stackProblems(), []);
      assert.doesNotThrow(() => assertStack());
      assert.equal(stackName(), "dev");
      assert.equal(stateRoot(), join(home, ".useful-bot-dev-app"));
      assert.equal(routerPort(), 4419);
      assert.equal(webPort(), 4420);
      assert.equal(evePort(), 4421);
      assert.equal(routerOrigin(), "http://127.0.0.1:4419");
      assert.equal(eveOrigin(), "http://127.0.0.1:4421");
      assert.equal(webOrigin(), "http://127.0.0.1:4420");
      assert.equal(keychainPrefix(), "com.usefulbot.dev");
      assert.equal(keychainName("device.desktop"), "com.usefulbot.dev.device.desktop");
      assert.equal(routerDbPath(), join(home, ".useful-bot-dev-app", "router", "usage.sqlite"));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dev with any required value missing throws and names it", () => {
  const home = tempHome();
  try {
    for (const missing of ["UB_STATE_ROOT", "UB_ROUTER_PORT", "UB_WEB_PORT", "UB_EVE_PORT", "UB_KEYCHAIN_PREFIX", "UB_MEDIA_DIR"]) {
      const env: Record<string, string | undefined> = { ...devEnv(home), [missing]: undefined };
      withEnv(env, () => {
        assert.throws(() => assertStack(), new RegExp(missing), `${missing} missing`);
        assert.ok(stackProblems().some((problem) => problem.includes(missing)), missing);
      });
    }
    // Empty is missing too.
    withEnv({ ...devEnv(home), UB_KEYCHAIN_PREFIX: "" }, () => assert.throws(() => assertStack(), /UB_KEYCHAIN_PREFIX/));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dev with a daily-equal value throws, however the path is spelled", () => {
  const home = tempHome();
  try {
    const cases: Array<[string, string]> = [
      ["UB_STATE_ROOT", join(home, ".useful-bot")],
      ["UB_STATE_ROOT", `${join(home, ".useful-bot")}/`],
      ["UB_STATE_ROOT", join(home, "x", "..", ".useful-bot")],
      // The owner's older dev data: never adopted either.
      ["UB_STATE_ROOT", join(home, ".useful-bot-dev")],
      ["UB_ROUTER_PORT", "4319"],
      ["UB_WEB_PORT", "4320"],
      ["UB_EVE_PORT", "4321"],
      ["UB_KEYCHAIN_PREFIX", "com.usefulbot"],
      ["UB_MEDIA_DIR", join(home, "Documents", "Useful Bot")],
    ];
    for (const [name, value] of cases) {
      withEnv({ ...devEnv(home), [name]: value }, () => {
        assert.throws(() => assertStack(), new RegExp(name), `${name}=${value}`);
      });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a dev service entry exits non-zero before it starts anything", () => {
  const home = tempHome();
  try {
    const bare = { ...process.env, HOME: home, UB_STACK: "dev" } as Record<string, string>;
    for (const key of ALL_VARS) if (key !== "HOME" && key !== "UB_STACK") delete bare[key];
    for (const mode of ["router", "eve", "web"]) {
      const result = spawnSync(process.execPath, [join(ROOT, "scripts/service.mjs"), mode], {
        env: bare, encoding: "utf8", timeout: 20_000,
      });
      assert.notEqual(result.status, 0, `${mode} must not start on a bare dev env`);
      assert.match(result.stderr, /UB_STATE_ROOT/, mode);
      assert.match(result.stderr, /UB_KEYCHAIN_PREFIX/, mode);
    }
    // A complete dev env gets past the check: an unknown mode then prints usage (exit 2).
    const ok = spawnSync(process.execPath, [join(ROOT, "scripts/service.mjs"), "nonsense"], {
      env: { ...bare, ...devEnv(home) }, encoding: "utf8", timeout: 20_000,
    });
    assert.equal(ok.status, 2);
    assert.match(ok.stderr, /usage: service\.mjs/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3b. The dev state root and media folder are judged on their real location.

/** A temp HOME with the owner's daily data folders already in it. */
function homeWithDailyData(): string {
  const home = realpathSync(tempHome());
  mkdirSync(join(home, ".useful-bot"));
  mkdirSync(join(home, ".useful-bot-dev"));
  mkdirSync(join(home, "Documents", "Useful Bot"), { recursive: true });
  mkdirSync(join(home, "Library", "Application Support", "Useful Bot", "app"), { recursive: true });
  return home;
}

const problemsFor = (home: string, extra: Record<string, string | undefined>) =>
  withEnv({ ...devEnv(home), ...extra }, () => stackProblems());

test("a dev state root that is, sits under, contains or links to daily data is refused", () => {
  const home = homeWithDailyData();
  try {
    symlinkSync(join(home, ".useful-bot"), join(home, ".useful-bot-link"));
    symlinkSync(join(home, ".useful-bot"), join(home, "shortcut"));
    // A link with an acceptable name that still lands on the daily root.
    symlinkSync(join(home, ".useful-bot"), join(home, ".useful-bot-dev-link"));
    // A dangling link whose target would be created inside the daily root.
    symlinkSync(join(home, ".useful-bot", "fresh"), join(home, ".useful-bot-dangling"));
    symlinkSync(join(home, ".useful-bot-dev"), join(home, ".useful-bot-older"));
    const refused: Array<[string, string]> = [
      ["lexically the daily root", join(home, ".useful-bot")],
      ["case-insensitive daily root", join(home, ".USEFUL-BOT")],
      ["case-insensitive older dev data", join(home, ".Useful-Bot-Dev")],
      ["under the daily root", join(home, ".useful-bot", "sub", ".useful-bot-dev-app")],
      ["under older dev data", join(home, ".useful-bot-dev", ".useful-bot-x")],
      ["symlink to the daily root", join(home, ".useful-bot-dev-link")],
      ["symlink to older dev data", join(home, ".useful-bot-older")],
      ["dangling symlink into the daily root", join(home, ".useful-bot-dangling")],
      ["a new leaf under a symlinked parent", join(home, "shortcut", ".useful-bot-new")],
      ["dotted spelling", join(home, "x", "..", ".useful-bot")],
      ["trailing slash", `${join(home, ".useful-bot")}/`],
    ];
    // APFS (the default) folds case, so a differently cased link name is the same link.
    if (existsSync(join(home, "SHORTCUT"))) refused.push(["a differently cased symlinked parent", join(home, "SHORTCUT", ".useful-bot-new")]);
    for (const [label, root] of refused) {
      const problems = problemsFor(home, { UB_STATE_ROOT: root });
      assert.ok(problems.some((problem) => problem.includes("UB_STATE_ROOT")), `${label}: ${root}`);
    }
    // Wrong folder name: the bot deny-lists key on the app-state names.
    for (const name of ["dev-state", ".useful-botany", "useful-bot-dev-app", ".useful-bots"]) {
      const problems = problemsFor(home, { UB_STATE_ROOT: join(home, name) });
      assert.ok(problems.some((problem) => /UB_STATE_ROOT.*name/i.test(problem)), name);
    }
    // Fine: a fresh dev root, an existing one, and a link to somewhere harmless.
    mkdirSync(join(home, ".useful-bot-elsewhere"));
    symlinkSync(join(home, ".useful-bot-elsewhere"), join(home, ".useful-bot-harmless"));
    // A link whose target is not named like an app-state folder is refused: the kernel sees the target's name.
    mkdirSync(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), join(home, ".useful-bot-badtarget"));
    assert.ok(problemsFor(home, { UB_STATE_ROOT: join(home, ".useful-bot-badtarget") }).some((problem) => /UB_STATE_ROOT.*name/i.test(problem)));
    for (const ok of [join(home, ".useful-bot-dev-app"), join(home, ".useful-bot-harmless"), join(home, "work", ".useful-bot-dev-x")]) {
      assert.deepEqual(problemsFor(home, { UB_STATE_ROOT: ok }), [], ok);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("on dev, any symlink inside the state root is refused, wherever it points", () => {
  const home = homeWithDailyData();
  try {
    const root = join(home, ".useful-bot-dev-app");
    // Clean: regular files and nested folders pass, as does a root that does not exist yet.
    assert.deepEqual(problemsFor(home, {}), []);
    mkdirSync(join(root, "memory", "deep"), { recursive: true });
    mkdirSync(join(root, "router"), { recursive: true });
    writeFileSync(join(root, "providers.json"), "{}");
    writeFileSync(join(root, "memory", "deep", "note.md"), "x");
    writeFileSync(join(root, "router", "usage.sqlite"), "");
    assert.deepEqual(problemsFor(home, {}), []);
    // config.json linked to a daily config, with UB_ROUTER_CONFIG spelled exactly as allowed.
    writeFileSync(join(home, ".useful-bot", "config.json"), "{}");
    symlinkSync(join(home, ".useful-bot", "config.json"), join(root, "config.json"));
    const withConfig = problemsFor(home, { UB_ROUTER_CONFIG: join(root, "config.json") });
    assert.ok(withConfig.some((p) => p.includes(join(root, "config.json")) && /is a symlink/.test(p)), withConfig.join("; "));
    rmSync(join(root, "config.json"));
    // config.json hard-linked to the daily config is a regular file, but still a second name for it.
    linkSync(join(home, ".useful-bot", "config.json"), join(root, "config.json"));
    const hard = problemsFor(home, { UB_ROUTER_CONFIG: join(root, "config.json") });
    assert.ok(hard.some((p) => p.includes(join(root, "config.json")) && /is a hard link/.test(p)), hard.join("; "));
    rmSync(join(root, "config.json"));
    // A nested link to daily memory.
    symlinkSync(join(home, ".useful-bot"), join(root, "memory", "x"));
    const nested = problemsFor(home, {});
    assert.ok(nested.some((p) => p.includes(join(root, "memory", "x")) && /is a symlink/.test(p)), nested.join("; "));
    unlinkSync(join(root, "memory", "x"));
    // A link that stays inside the dev root is refused too: no links at all.
    symlinkSync(join(root, "providers.json"), join(root, "providers-copy.json"));
    const inside = problemsFor(home, {});
    assert.ok(inside.some((p) => p.includes("providers-copy.json") && /is a symlink/.test(p)), inside.join("; "));
    // A dangling link counts as well.
    symlinkSync(join(home, "nowhere"), join(root, "router", "dangling"));
    assert.ok(problemsFor(home, {}).some((p) => p.includes("dangling")));
    // assertStack fails on it.
    assert.throws(() => withEnv({ ...devEnv(home) }, () => assertStack()), /symlink/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("on dev, the state root walk reports at most 5 links and fails closed past its entry cap", () => {
  const home = realpathSync(tempHome());
  try {
    const root = join(home, ".useful-bot-dev-app");
    mkdirSync(root);
    for (let i = 0; i < 8; i++) symlinkSync(home, join(root, `l${i}`));
    const many = stateRootLinkProblems(root);
    assert.equal(many.filter((p) => /is a symlink/.test(p)).length, 5, many.join("; "));
    // Cap: 30 plain files with a limit of 10 is a problem, never a pass.
    const big = join(home, ".useful-bot-dev-big");
    mkdirSync(big);
    for (let i = 0; i < 30; i++) writeFileSync(join(big, `f${i}`), "");
    const capped = stateRootLinkProblems(big, 10);
    assert.ok(capped.some((p) => /too many entries|could not be checked/.test(p)), capped.join("; "));
    assert.deepEqual(stateRootLinkProblems(big, 1000), []);
    assert.deepEqual(stateRootLinkProblems(join(home, "missing")), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a protected daily folder that cannot be resolved is a problem, never a skipped check", () => {
  const home = realpathSync(tempHome());
  try {
    // A symlink loop where the daily state root should be: realpath fails with ELOOP.
    symlinkSync(join(home, ".useful-bot"), join(home, ".useful-bot"));
    for (const extra of [{}, { UB_MEDIA_DIR: join(home, "Documents", "Useful Bot Dev") }, { UB_WORKSPACE_ROOT: home }]) {
      const problems = problemsFor(home, extra);
      assert.ok(problems.some((problem) => /cannot be resolved/.test(problem) && problem.includes(".useful-bot")), problems.join("; "));
    }
    assert.throws(() => withEnv(devEnv(home), () => assertStack()), /cannot be resolved/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a planted link on the daily folder cannot hide that a dev path sits inside it", () => {
  const home = realpathSync(tempHome());
  try {
    mkdirSync(join(home, "stash"));
    // The daily root is a link elsewhere; a dev root spelled through it is inside it, lexically and on disk.
    symlinkSync(join(home, "stash"), join(home, ".useful-bot"));
    for (const path of [join(home, ".useful-bot", ".useful-bot-dev-app"), join(home, "stash", ".useful-bot-dev-app")]) {
      assert.ok(problemsFor(home, { UB_STATE_ROOT: path }).some((problem) => /UB_STATE_ROOT.*daily state root/.test(problem)), path);
    }
    assert.ok(problemsFor(home, { UB_MEDIA_DIR: join(home, "stash", "media") }).some((problem) => /UB_MEDIA_DIR.*daily state root/.test(problem)));
    assert.ok(problemsFor(home, { UB_WORKSPACE_ROOT: join(home, "stash", "work") }).some((problem) => /UB_WORKSPACE_ROOT.*daily state root/.test(problem)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a dev state root that is an ancestor of daily data is refused even with a valid name", () => {
  // The HOME's own name is an app-state segment, so only the ancestor rule can refuse it.
  const outer = realpathSync(tempHome());
  const home = join(outer, ".useful-bot-h");
  try {
    mkdirSync(join(home, ".useful-bot"), { recursive: true });
    const problems = problemsFor(home, { UB_STATE_ROOT: home });
    assert.ok(problems.some((problem) => /UB_STATE_ROOT/.test(problem) && /daily/.test(problem)), problems.join("; "));
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("a dev media folder that is, sits under, contains or links to daily data is refused", () => {
  const home = homeWithDailyData();
  try {
    symlinkSync(join(home, "Documents", "Useful Bot"), join(home, "media-link"));
    symlinkSync(join(home, ".useful-bot"), join(home, "state-link"));
    const refused: Array<[string, string]> = [
      ["the daily media folder", join(home, "Documents", "Useful Bot")],
      ["case-insensitive", join(home, "Documents", "USEFUL BOT")],
      ["under it", join(home, "Documents", "Useful Bot", "Dev")],
      ["ancestor Documents", join(home, "Documents")],
      ["ancestor home", home],
      ["symlink to it", join(home, "media-link")],
      ["new leaf under a link to it", join(home, "media-link", "Dev")],
      ["inside the daily state root", join(home, ".useful-bot", "media")],
      ["through a link to the daily state root", join(home, "state-link", "media")],
      ["inside older dev data", join(home, ".useful-bot-dev", "media")],
      ["inside the daily app install", join(home, "Library", "Application Support", "Useful Bot", "media")],
    ];
    for (const [label, media] of refused) {
      const problems = problemsFor(home, { UB_MEDIA_DIR: media });
      assert.ok(problems.some((problem) => problem.includes("UB_MEDIA_DIR")), `${label}: ${media}`);
    }
    assert.deepEqual(problemsFor(home, { UB_MEDIA_DIR: join(home, "Documents", "Useful Bot Dev") }), []);
    // Relative paths are never resolved against a working directory.
    assert.ok(problemsFor(home, { UB_MEDIA_DIR: "Documents/Useful Bot Dev" }).some((problem) => problem.includes("UB_MEDIA_DIR")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3c. The dev stack takes no per-store override at all: stores derive from UB_STATE_ROOT.

test("on dev, every per-store override is refused, however it is spelled; daily still honours them", () => {
  const home = homeWithDailyData();
  try {
    const state = join(home, ".useful-bot-dev-app");
    mkdirSync(join(state, "router"), { recursive: true });
    mkdirSync(join(home, "elsewhere"));
    for (const name of STORE_OVERRIDE_VARS) {
      for (const value of [join(state, "x.json"), join(home, "elsewhere", "x"), "x.json"]) {
        const problems = problemsFor(home, { [name]: value });
        assert.ok(
          problems.some((problem) => problem.includes(`${name} is not allowed on the dev stack; dev stores live under UB_STATE_ROOT`)),
          `${name}: ${value}`,
        );
      }
      assert.deepEqual(withEnv({ HOME: home, [name]: join(home, "elsewhere", "x") }, () => stackProblems()), [], `${name} daily`);
    }
    // scripts/service.mjs hands the router and web children UB_ROUTER_CONFIG as the path derived from the state root.
    assert.deepEqual(problemsFor(home, { UB_ROUTER_CONFIG: join(state, "config.json") }), []);
    assert.ok(problemsFor(home, { UB_ROUTER_CONFIG: `${state}/./config.json` }).some((p) => p.includes("UB_ROUTER_CONFIG")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("on dev, the dotted-link and linked-file overrides that reach daily data are refused", () => {
  const home = homeWithDailyData();
  try {
    const state = join(home, ".useful-bot-dev-app");
    mkdirSync(state);
    mkdirSync(join(home, ".useful-bot", "router"));
    // dev/bridge -> daily/router, so dev/bridge/../router/usage.sqlite is daily/router/../router/... on disk.
    symlinkSync(join(home, ".useful-bot", "router"), join(state, "bridge"));
    mkdirSync(join(state, "router"));
    assert.ok(problemsFor(home, { UB_ROUTER_DB: `${state}/bridge/../router/usage.sqlite` }).some((p) => p.includes("UB_ROUTER_DB")));
    // A daily file that is a link into dev: the atomic write would replace the daily file.
    writeFileSync(join(state, "limits.json"), "{}");
    symlinkSync(join(state, "limits.json"), join(home, ".useful-bot", "limits.json"));
    assert.ok(problemsFor(home, { UB_LIMITS_PATH: join(home, ".useful-bot", "limits.json") }).some((p) => p.includes("UB_LIMITS_PATH")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("on dev, a '..' segment in the state root, media folder or workspace root is refused before resolving", () => {
  const home = homeWithDailyData();
  try {
    const state = join(home, ".useful-bot-dev-app");
    mkdirSync(state);
    symlinkSync(join(home, ".useful-bot"), join(state, "bridge"));
    for (const [name, value] of [
      ["UB_STATE_ROOT", `${state}/bridge/../.useful-bot-dev-app`],
      ["UB_STATE_ROOT", `${home}/x/../.useful-bot-dev-app`],
      ["UB_MEDIA_DIR", `${state}/bridge/../Documents/Useful Bot Dev`],
      ["UB_WORKSPACE_ROOT", `${state}/bridge/../elsewhere`],
    ]) {
      const problems = problemsFor(home, { [name]: value });
      assert.ok(problems.some((p) => p.includes(name) && p.includes("..")), `${name}: ${value}`);
    }
    // The planted bridge itself is now refused as a link, and nothing else is wrong.
    assert.deepEqual(problemsFor(home, {}).filter((p) => !/bridge is a symlink/.test(p)), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("on dev, the state root's folder name must be a lowercase .useful-bot-<word> the kernel sandbox protects", () => {
  const home = homeWithDailyData();
  try {
    for (const bad of [".useful-bot+dev", ".Useful-Bot-Dev", ".useful-bot_dev", ".useful-bot-", ".useful-bot--dev", ".useful-bot-dev.app", ".useful-bot"]) {
      const problems = problemsFor(home, { UB_STATE_ROOT: join(home, bad) });
      assert.ok(problems.length > 0, bad);
    }
    // The name as resolved counts too: a good link name onto a bad directory name.
    mkdirSync(join(home, ".useful-bot+real"));
    symlinkSync(join(home, ".useful-bot+real"), join(home, ".useful-bot-goodlink"));
    assert.ok(problemsFor(home, { UB_STATE_ROOT: join(home, ".useful-bot-goodlink") }).some((p) => p.includes("folder name")));
    // Every accepted name is denied, for read and write, by the sandbox's own regexes.
    const rules = [sandboxProfile(null), sandboxProfile(null, "computer", true)].flatMap((profile) =>
      [...profile.matchAll(/\(deny file-(read|write)\* \(regex #"([^"]*)"\)\)/g)].map((m) => ({ op: m[1], re: new RegExp(m[2]) })),
    );
    for (const good of [".useful-bot-dev-app", ".useful-bot-test", ".useful-bot-a", ".useful-bot-x1-y2-z3", ".useful-bot-9"]) {
      assert.deepEqual(problemsFor(home, { UB_STATE_ROOT: join(home, good) }), [], good);
      for (const op of ["read", "write"]) {
        for (const path of [`${home}/${good}`, `${home}/${good}/router/usage.sqlite`]) {
          assert.ok(rules.some((rule) => rule.op === op && rule.re.test(path)), `${op} ${path} must be denied`);
        }
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("on dev, the checked override list names every store variable the real setup:dev sets or a module reads", () => {
  for (const name of [
    "UB_ROUTER_CONFIG", "UB_ROUTER_DB", "UB_AGENT_STORE_PATH", "UB_SHELL_PATH", "UB_APPROVALS_PATH", "UB_WORKSPACE_STORE_PATH",
    "UB_ROUTINES_PATH", "UB_WEB_SESSIONS_PATH", "UB_HANDOFF_DIR", "UB_MEMORY_ROOT", "UB_WIDGETS_DIR", "UB_IMAGES_DIR",
    "UB_MEDIA_INDEX_PATH", "UB_PROVIDERS_PATH", "UB_PROVIDER_OAUTH_PATH", "UB_MODELS_CACHE_PATH", "UB_CONNECTORS_PATH",
    "UB_CONNECTIONS_PATH", "UB_CONNECTION_TOOLS_PATH", "UB_OAUTH_PENDING_PATH", "UB_CATALOGUE_PATH", "UB_LIMITS_PATH",
  ]) {
    assert.ok((STORE_OVERRIDE_VARS as readonly string[]).includes(name), name);
  }
});

// UB_* variables that name a place or an origin and are checked somewhere other
// than STORE_OVERRIDE_VARS / ORIGIN_OVERRIDE_VARS, each with the reason.
const PLACE_VAR_EXEMPT: Record<string, string> = {
  UB_STATE_ROOT: "the stack's own root, checked in stackProblems",
  UB_MEDIA_DIR: "the media folder, checked in stackProblems",
  UB_WORKSPACE_ROOT: "the bot's working root, checked against the protected daily dirs in stackProblems",
  UB_OWNER_PATH: "a PATH search list for child processes, not a place that is written",
  UB_INSTALL_DIR: "scripts/install.sh, the installer for the app bundle; never runs inside a stack",
  UB_PAYLOAD_PROBE_DIR: "router/src/payload-probe.ts, a dump folder that the router itself refuses outside the dev stack",
  UB_FEED_URL: "scripts/release-mac.mjs, the public update feed baked into a release build",
};

test("every UB_*_PATH, _DIR, _ROOT, _DB, _CONFIG, _BASE or _URL variable in the code is checked or exempt", () => {
  const found = new Map<string, string>();
  const scan = (file: string) => {
    for (const match of readFileSync(join(ROOT, file), "utf8").matchAll(/\bUB_[A-Z0-9_]+\b/g)) {
      if (/_(PATH|DIR|ROOT|DB|CONFIG|BASE|URL|BIN|FILE|HOME)$/.test(match[0])) found.set(match[0], file);
    }
  };
  for (const dir of [...SCAN_DIRS, "services"]) {
    if (!existsSync(join(ROOT, dir))) continue;
    for (const file of sourceFiles(dir)) scan(file);
  }
  for (const entry of readdirSync(join(ROOT, "scripts"))) if (entry.endsWith(".sh")) scan(`scripts/${entry}`);
  // An empty or stale list would silently switch every one of these checks off.
  assert.ok(STORE_OVERRIDE_VARS.length >= 20, "STORE_OVERRIDE_VARS is populated");
  assert.ok(ORIGIN_OVERRIDE_VARS.length >= 3, "ORIGIN_OVERRIDE_VARS is populated");
  for (const [name, file] of found) {
    if (/_(BASE|BASE_URL)$/.test(name)) assert.ok((ORIGIN_OVERRIDE_VARS as readonly string[]).includes(name), `${name} (${file}) must be in ORIGIN_OVERRIDE_VARS`);
    if (/_(PATH|DIR|ROOT|DB|CONFIG)$/.test(name) && !(name in PLACE_VAR_EXEMPT)) {
      assert.ok((STORE_OVERRIDE_VARS as readonly string[]).includes(name), `${name} (${file}) must be in STORE_OVERRIDE_VARS`);
    }
  }
  for (const name of [...STORE_OVERRIDE_VARS, ...ORIGIN_OVERRIDE_VARS]) assert.ok(found.has(name), `${name} is listed but no longer read anywhere`);
  const covered = new Set<string>([...STORE_OVERRIDE_VARS, ...ORIGIN_OVERRIDE_VARS, ...Object.keys(PLACE_VAR_EXEMPT)]);
  const unchecked = [...found].filter(([name]) => !covered.has(name)).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(unchecked, [], `add each to STORE_OVERRIDE_VARS / ORIGIN_OVERRIDE_VARS in shared/stack.ts so the dev stack checks it, or to PLACE_VAR_EXEMPT with a reason:\n${unchecked.join("\n")}`);
  for (const name of Object.keys(PLACE_VAR_EXEMPT)) assert.ok(found.has(name), `${name} is exempt but no longer in the code`);
});

test("on dev, the bot working root may not sit at or under a protected daily folder", () => {
  const home = homeWithDailyData();
  try {
    symlinkSync(join(home, ".useful-bot"), join(home, "link"));
    symlinkSync(join(home, "Documents", "Useful Bot"), join(home, "medialink"));
    const refused = [
      join(home, ".useful-bot"), join(home, ".useful-bot", "x"), join(home, ".USEFUL-BOT", "x"), join(home, ".useful-bot-dev"),
      join(home, "Documents", "Useful Bot"), join(home, "Documents", "Useful Bot", "x"),
      join(home, "Library", "Application Support", "Useful Bot"), join(home, "Library", "Application Support", "Useful Bot", "app"),
      join(home, "link"), join(home, "link", "x"), join(home, "medialink"), "relative/root",
    ];
    for (const root of refused) {
      assert.ok(problemsFor(home, { UB_WORKSPACE_ROOT: root }).some((problem) => problem.includes("UB_WORKSPACE_ROOT")), root);
    }
    // $HOME is an ancestor of the daily folders and is the normal working root.
    for (const ok of [home, join(home, "Desktop"), join(home, "Documents")]) {
      assert.deepEqual(problemsFor(home, { UB_WORKSPACE_ROOT: ok }), [], ok);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3d. Ports: a dev service never takes a daily port, and no two share one.

test("on dev, no service may take any daily port, and no two services may share a port", () => {
  const home = tempHome();
  try {
    for (const name of ["UB_ROUTER_PORT", "UB_WEB_PORT", "UB_EVE_PORT"]) {
      for (const daily of ["4319", "4320", "4321"]) {
        const problems = problemsFor(home, { [name]: daily });
        assert.ok(problems.some((problem) => problem.includes(name) && /daily/.test(problem)), `${name}=${daily}`);
      }
    }
    for (const [a, b] of [["UB_ROUTER_PORT", "UB_WEB_PORT"], ["UB_ROUTER_PORT", "UB_EVE_PORT"], ["UB_WEB_PORT", "UB_EVE_PORT"]]) {
      const problems = problemsFor(home, { [a]: "4499", [b]: "4499" });
      assert.ok(problems.some((problem) => problem.includes(a) && problem.includes(b) && /same port|duplicate/i.test(problem)), `${a}/${b}: ${problems.join("; ")}`);
    }
    assert.deepEqual(problemsFor(home, {}), []);
    // The daily stack keeps its own ports and may be moved freely.
    assert.deepEqual(withEnv({ HOME: home, UB_ROUTER_PORT: "4320", UB_WEB_PORT: "4319" }, () => stackProblems()), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3e. Origin overrides never aim a dev service at a daily one.

test("on dev, an origin override on a loopback host and a daily port is refused, in any spelling", () => {
  const home = tempHome();
  try {
    const hosts = ["127.0.0.1", "localhost", "LOCALHOST", "localhost.", "[::1]", "0.0.0.0", "127.1", "2130706433", "127.5.5.5", "[::ffff:127.0.0.1]"];
    for (const name of ORIGIN_OVERRIDE_VARS) {
      for (const host of hosts) {
        for (const port of ["4319", "4320", "4321"]) {
          const value = `http://${host}:${port}/v1`;
          const problems = problemsFor(home, { [name]: value });
          assert.ok(problems.some((problem) => problem.includes(name)), `${name}=${value}`);
        }
      }
      assert.ok(problemsFor(home, { [name]: "not a url" }).some((problem) => problem.includes(name)), `${name} malformed`);
      for (const ok of ["http://127.0.0.1:4419/v1", "http://localhost:9", "https://api.example.com", "http://127.0.0.1/", "http://example.com:4319"]) {
        assert.deepEqual(problemsFor(home, { [name]: ok }), [], `${name}=${ok}`);
      }
      // Daily is not constrained.
      assert.deepEqual(withEnv({ HOME: home, [name]: "http://127.0.0.1:4319/v1" }, () => stackProblems()), [], `${name} daily`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Keychain names follow the prefix.

test("keychain service names follow the daily prefix and refuse junk", () => {
  const home = tempHome();
  try {
    withEnv({ HOME: home }, () => {
      const kc = memoryKeychain();
      setKeychainDriver(kc);
      try {
        assert.equal(connectionSecretService("abc"), "com.usefulbot.connection.abc");
        keychainSet("com.usefulbot.connection.abc", "v");
        assert.equal(keychainGet("com.usefulbot.connection.abc"), "v");
        for (const junk of [
          "com.usefulbot.", "com.usefulbot", "com.usefulbotx.y", "evil.com.usefulbot.x", "com.usefulbot.UPPER",
          "com.usefulbot.a b", "com.usefulbot.a;b", "org.other.thing", "",
          // The dev stack's items are not the daily stack's to read or write.
          "com.usefulbot.dev.connection.abc", "com.usefulbot.dev.device.desktop",
        ]) {
          assert.throws(() => keychainSet(junk, "v"), /keychain_service/, junk);
          assert.throws(() => keychainGet(junk), /keychain_service/, junk);
        }
        assert.throws(() => connectionSecretService("Bad Id"), /keychain_service/);
      } finally {
        setKeychainDriver(null);
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the Keychain wrapper refuses every call when UB_KEYCHAIN_PREFIX is not its stack's own", () => {
  const home = tempHome();
  try {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ HOME: home, UB_KEYCHAIN_PREFIX: "com.usefulbot.dev" }, "com.usefulbot.dev.connection.abc"],
      [{ HOME: home, UB_KEYCHAIN_PREFIX: "com.usefulbot.dev" }, "com.usefulbot.connection.abc"],
      [{ ...devEnv(home), UB_KEYCHAIN_PREFIX: "com.usefulbot.router" }, "com.usefulbot.router.connection.abc"],
      [{ ...devEnv(home), UB_KEYCHAIN_PREFIX: "com.usefulbot" }, "com.usefulbot.connection.abc"],
    ];
    for (const [env, service] of cases) {
      withEnv(env, () => {
        const kc = memoryKeychain();
        setKeychainDriver(kc);
        try {
          assert.throws(() => keychainSet(service, "v"), /./, service);
          assert.throws(() => keychainGet(service), /./, service);
          assert.throws(() => connectionSecretService("abc"), /./, service);
          assert.equal(kc.store.size, 0, `${service} wrote`);
        } finally {
          setKeychainDriver(null);
        }
      });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("keychain service names follow the dev prefix and refuse daily names", () => {
  const home = tempHome();
  try {
    withEnv(devEnv(home), () => {
      const kc = memoryKeychain();
      setKeychainDriver(kc);
      try {
        assert.equal(connectionSecretService("abc"), "com.usefulbot.dev.connection.abc");
        keychainSet("com.usefulbot.dev.connection.abc", "v");
        assert.equal(keychainGet("com.usefulbot.dev.connection.abc"), "v");
        assert.deepEqual([...kc.store.keys()], ["com.usefulbot.dev.connection.abc"]);
        for (const junk of [
          "com.usefulbot.connection.abc", "com.usefulbot.device.desktop", "com.usefulbot.dev", "com.usefulbot.dev.",
          "com.usefulbot.dev.UPPER", "com.usefulbot.devx.abc", "evil.com.usefulbot.dev.x",
        ]) {
          assert.throws(() => keychainSet(junk, "v"), /keychain_service/, junk);
          assert.throws(() => keychainGet(junk), /keychain_service/, junk);
        }
      } finally {
        setKeychainDriver(null);
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the Keychain namespace is fixed by the stack: only com.usefulbot on daily, only com.usefulbot.dev on dev", () => {
  const home = tempHome();
  try {
    // Daily: unset or exactly its own prefix. Anything else, the dev one included, is refused.
    assert.equal(withEnv({ HOME: home }, () => keychainPrefix()), "com.usefulbot");
    assert.equal(withEnv({ HOME: home, UB_KEYCHAIN_PREFIX: "com.usefulbot" }, () => keychainPrefix()), "com.usefulbot");
    for (const bad of ["com.usefulbot.dev", "com.usefulbot.router", "com.other", "com.usefulbot.x"]) {
      withEnv({ HOME: home, UB_KEYCHAIN_PREFIX: bad }, () => {
        assert.throws(() => keychainPrefix(), /UB_KEYCHAIN_PREFIX/, `daily ${bad}`);
        assert.ok(stackProblems().some((problem) => problem.includes("UB_KEYCHAIN_PREFIX")), `daily ${bad}`);
      });
    }
    // Dev: exactly com.usefulbot.dev, and the function returns it even when unset.
    withEnv(devEnv(home), () => assert.equal(keychainPrefix(), "com.usefulbot.dev"));
    withEnv({ ...devEnv(home), UB_KEYCHAIN_PREFIX: undefined }, () => assert.equal(keychainPrefix(), "com.usefulbot.dev"));
    for (const bad of ["com.usefulbot", "com.usefulbot.router", "com.usefulbot.devx", "com.usefulbot.dev.x", "com.usefulbot.dev.", "com.other.dev"]) {
      withEnv({ ...devEnv(home), UB_KEYCHAIN_PREFIX: bad }, () => {
        assert.throws(() => keychainPrefix(), /UB_KEYCHAIN_PREFIX/, `dev ${bad}`);
        assert.ok(stackProblems().some((problem) => problem.includes("UB_KEYCHAIN_PREFIX")), `dev ${bad}`);
        assert.throws(() => assertStack(), /UB_KEYCHAIN_PREFIX/, `dev ${bad}`);
      });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("keychainServiceAllowed: each stack owns its own namespace and nothing else", () => {
  const home = tempHome();
  try {
    withEnv({ HOME: home }, () => {
      for (const ok of ["com.usefulbot.device.desktop", "com.usefulbot.router.ops", "com.usefulbot.devices.x", "com.usefulbot.connection.abc"]) {
        assert.equal(keychainServiceAllowed(ok), true, ok);
      }
      for (const bad of [
        "com.usefulbot.dev", "com.usefulbot.dev.device.desktop", "com.usefulbot.dev.connection.abc", "com.usefulbot", "com.usefulbot.",
        "com.usefulbotx.a", "evil.com.usefulbot.a", "", "com.usefulbot.a b",
        // Names reach `security -i` command lines: nothing that could end or extend one.
        "com.usefulbot.a\nb", "com.usefulbot.a\n", "com.usefulbot.a\tb", 'com.usefulbot.a"b', "com.usefulbot.a'b", "com.usefulbot.a;b",
        "com.usefulbot.a$b", "com.usefulbot.a`b`", "com.usefulbot.UPPER", "com.usefulbot.-a", `com.usefulbot.a${"b".repeat(121)}`,
      ]) {
        assert.equal(keychainServiceAllowed(bad), false, bad);
      }
      assert.equal(keychainServiceAllowed(undefined as unknown as string), false);
    });
    withEnv(devEnv(home), () => {
      for (const ok of ["com.usefulbot.dev.device.desktop", "com.usefulbot.dev.router.ops", "com.usefulbot.dev.connection.abc"]) {
        assert.equal(keychainServiceAllowed(ok), true, ok);
      }
      for (const bad of [
        "com.usefulbot.device.desktop", "com.usefulbot.router.ops", "com.usefulbot.connection.abc", "com.usefulbot.dev", "com.usefulbot.dev.",
        "com.usefulbot.devx.abc", "com.usefulbot.dev.UPPER", "evil.com.usefulbot.dev.x",
        "com.usefulbot.dev.a b", "com.usefulbot.dev.a\nb", 'com.usefulbot.dev.a"b', "com.usefulbot.dev.a;b", "com.usefulbot.dev.a\n",
      ]) {
        assert.equal(keychainServiceAllowed(bad), false, bad);
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a malformed UB_KEYCHAIN_PREFIX is refused", () => {
  for (const bad of ["evil", "com.usefulbot.dev;rm -rf", "COM.usefulbot", "com..usefulbot", "com.usefulbot."]) {
    withEnv({ UB_KEYCHAIN_PREFIX: bad }, () => assert.throws(() => keychainPrefix(), /UB_KEYCHAIN_PREFIX/, bad));
  }
});

// ---------------------------------------------------------------------------
// 5. setup-local (end to end, against the Keychain stub) honours the stack.

const HOOKS = join(ROOT, "test/fixtures/security-stub/hooks.mjs");
const STUB_SH = join(ROOT, "test/fixtures/security-stub/security.sh");

function setupBox() {
  const base = mkdtempSync(join(tmpdir(), "ub-stack-setup-"));
  const home = join(base, "home");
  const keychain = join(base, "keychain");
  mkdirSync(home);
  mkdirSync(keychain);
  const run = (env: Record<string, string>, ...args: string[]) => {
    const clean = { ...process.env } as Record<string, string>;
    for (const key of ALL_VARS) delete clean[key];
    const result = spawnSync(process.execPath, ["--import", HOOKS, join(ROOT, "scripts/setup-local.mjs"), ...args], {
      env: { ...clean, HOME: home, STUB_SECURITY_BIN: STUB_SH, STUB_KEYCHAIN_DIR: keychain, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return { base, home, keychain, run };
}

test("setup-local on the dev stack writes under UB_STATE_ROOT and the dev Keychain prefix only", () => {
  const box = setupBox();
  try {
    const env = devEnv(box.home);
    const result = box.run(env);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(env.UB_STATE_ROOT, "config.json")), "config under the dev state root");
    assert.equal(existsSync(join(box.home, ".useful-bot")), false, "daily state root untouched");
    const items = readdirSync(box.keychain);
    assert.ok(items.length >= 5, `expected the five items, saw ${items.join(",")}`);
    for (const item of items) assert.ok(item.startsWith("com.usefulbot.dev."), `daily-prefixed item written: ${item}`);
    for (const name of ["device.desktop", "router.desktop", "router.ops", "router.reviewer", "channel.desktop"]) {
      assert.ok(items.includes(`com.usefulbot.dev.${name}`), name);
    }
    const printed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    assert.ok(Array.isArray(printed.keychainItems) && printed.keychainItems.every((item: string) => item.startsWith("com.usefulbot.dev.")));
    assert.equal(printed.config, join(env.UB_STATE_ROOT, "config.json"));
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

test("setup-local on a bare dev environment refuses and writes nothing", () => {
  const box = setupBox();
  try {
    const result = box.run({ UB_STACK: "dev" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UB_STATE_ROOT/);
    assert.match(result.stderr, /UB_KEYCHAIN_PREFIX/);
    assert.deepEqual(readdirSync(box.keychain), []);
    assert.equal(existsSync(join(box.home, ".useful-bot")), false);
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

test("setup-local refuses every mode, and writes nothing, when the Keychain prefix is not the stack's own", () => {
  const modes: string[][] = [[], ["--rotate"], ["--add-missing"], ["--rebuild-orphaned"]];
  const wrong: Array<(home: string) => Record<string, string>> = [
    () => ({ UB_KEYCHAIN_PREFIX: "com.usefulbot.dev" }),
    (home) => ({ ...devEnv(home), UB_KEYCHAIN_PREFIX: "com.usefulbot.router" }),
    (home) => ({ ...devEnv(home), UB_KEYCHAIN_PREFIX: "com.usefulbot" }),
  ];
  for (const makeEnv of wrong) {
    for (const mode of modes) {
      const box = setupBox();
      try {
        const result = box.run(makeEnv(box.home), ...mode);
        assert.notEqual(result.status, 0, `${mode.join(" ") || "setup"}: ${result.stdout}`);
        assert.match(result.stderr, /UB_KEYCHAIN_PREFIX/);
        assert.deepEqual(readdirSync(box.keychain), []);
        assert.equal(existsSync(join(box.home, ".useful-bot")), false);
        assert.equal(existsSync(join(box.home, ".useful-bot-dev-app")), false);
      } finally {
        rmSync(box.base, { recursive: true, force: true });
      }
    }
  }
});

test("setup-local with only UB_STATE_ROOT set still honours it; with nothing set it is the daily layout", () => {
  const box = setupBox();
  try {
    const root = join(box.base, "custom-root");
    const result = box.run({ UB_STATE_ROOT: root });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(root, "config.json")));
    assert.equal(existsSync(join(box.home, ".useful-bot")), false);
    for (const item of readdirSync(box.keychain)) assert.ok(item.startsWith("com.usefulbot."), item);
    assert.ok(readdirSync(box.keychain).includes("com.usefulbot.device.desktop"));
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
  const daily = setupBox();
  try {
    const result = daily.run({});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(daily.home, ".useful-bot", "config.json")));
    assert.ok(readdirSync(daily.keychain).includes("com.usefulbot.device.desktop"));
  } finally {
    rmSync(daily.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. The router reports its stack and accepts only its own configured port.

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

function rawGet(port: number, path: string, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host: hostHeader } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end();
  });
}

async function withRouter<T>(env: Record<string, string>, port: number, fn: () => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), "ub-stack-router-"));
  const clean = { ...process.env } as Record<string, string>;
  for (const key of ALL_VARS) delete clean[key];
  const future = new Date(Date.now() + 86400_000).toISOString();
  // A dev environment takes no store override: the database derives from UB_STATE_ROOT, and the config
  // is passed (as scripts/service.mjs does) only as exactly that derived path.
  const dev = env.UB_STACK === "dev";
  const configPath = dev ? join(env.UB_STATE_ROOT, "config.json") : env.UB_ROUTER_CONFIG ?? join(base, "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    phoneEnabled: false,
    tailnet: null,
    sandbox: { backend: "just-bash", evidenceId: "s3-non-vm-default", imageDigest: null },
    goBalanceDisabledConfirmedAt: null,
    searchKeyRequired: false,
    credentials: [
      { id: "d", kind: "router", sha256: createHash("sha256").update("stack-token").digest("hex"), callerId: "desktop", profile: "desktop", expiresAt: future, revokedAt: null },
    ],
  }));
  const child = spawn(process.execPath, ["--experimental-strip-types", "router/src/index.ts"], {
    cwd: ROOT,
    env: {
      ...clean,
      HOME: base,
      ...(dev ? { UB_ROUTER_CONFIG: configPath } : { UB_ROUTER_CONFIG: join(base, "config.json"), UB_ROUTER_DB: join(base, "usage.sqlite") }),
      ...env,
      UB_ROUTER_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await rawGet(port, "/health/live", `127.0.0.1:${port}`);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error(`router did not start: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return await fn();
  } finally {
    child.kill("SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
}

test("router /health/live says daily by default and dev when it is the dev stack", async () => {
  const dailyPort = await freePort();
  await withRouter({}, dailyPort, async () => {
    const live = await rawGet(dailyPort, "/health/live", `127.0.0.1:${dailyPort}`);
    assert.equal(live.status, 200);
    assert.equal(JSON.parse(live.body).stack, "daily");
  });
  const devPort = await freePort();
  const home = tempHome();
  try {
    // The dev stack takes no store override: config and usage database derive from UB_STATE_ROOT.
    await withRouter(devEnv(home), devPort, async () => {
      const live = await rawGet(devPort, "/health/live", `127.0.0.1:${devPort}`);
      assert.equal(live.status, 200);
      assert.deepEqual(JSON.parse(live.body), { ok: true, stack: "dev" });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the router host check accepts its own configured port and refuses the daily one", async () => {
  const port = await freePort();
  assert.notEqual(port, 4319);
  await withRouter({}, port, async () => {
    const own = await rawGet(port, "/v1/models", `127.0.0.1:${port}`);
    // Past the host check it reaches authentication, which refuses with 401.
    assert.equal(own.status, 401, own.body);
    const daily = await rawGet(port, "/v1/models", "127.0.0.1:4319");
    assert.equal(daily.status, 403, daily.body);
    assert.match(daily.body, /origin_forbidden/);
  });
});

test("the router refuses to start as dev without a complete dev environment", () => {
  const clean = { ...process.env } as Record<string, string>;
  for (const key of ALL_VARS) delete clean[key];
  const base = tempHome();
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "router/src/index.ts"], {
      cwd: ROOT,
      env: { ...clean, HOME: base, UB_STACK: "dev", UB_ROUTER_CONFIG: join(base, "c.json") },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UB_STATE_ROOT/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the web status, health and root routes report the stack", () => {
  // The routes sit behind Next's request context (cookies), so they cannot be
  // called from node:test. Their source is held to the one helper instead; the
  // helper itself is covered above.
  for (const file of ["web/app/api/status/route.ts", "web/app/api/health/route.ts", "web/app/route.ts"]) {
    const source = readFileSync(join(ROOT, file), "utf8");
    assert.match(source, /stack:\s*stackName\(\)/, file);
  }
});

// ---------------------------------------------------------------------------
// 7. Deny-lists block every app-state folder and nothing unrelated.

const BLOCKED_DIRS = [".useful-bot", ".useful-bot-dev", ".useful-bot-dev-app"];
const FREE_DIRS = [".useful-botany", "useful-bot", "useful-bot-dev", ".useful-bots"];

test("a grant on an app-state folder or anything inside one is refused; project folders are fine", () => {
  for (const dir of BLOCKED_DIRS) {
    assert.equal(isGrantableRootPath(`/Users/me/${dir}`), false, dir);
    assert.equal(isGrantableRootPath(`/Users/me/${dir}/router`), false, dir);
    assert.equal(isGrantableRootPath(`/Users/me/${dir.toUpperCase()}`), false, `${dir} upper`);
  }
  for (const dir of FREE_DIRS) assert.equal(isGrantableRootPath(`/Users/me/Desktop/${dir}`), true, dir);
  assert.equal(isGrantableRootPath("/Users/me/Desktop/useful-bot"), true);
});

test("the child-segment screen refuses every app-state name and keeps its other rules", () => {
  for (const dir of BLOCKED_DIRS) assert.equal(isForbiddenChildSegment(dir), true, dir);
  for (const dir of FREE_DIRS) assert.equal(isForbiddenChildSegment(dir), false, dir);
  // Unchanged neighbours: `.docker` is a store, `.dockerignore` is not.
  assert.equal(isForbiddenChildSegment(".docker"), true);
  assert.equal(isForbiddenChildSegment(".dockerignore"), false);
});

test("a path under a grant that touches an app-state folder is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-stack-ws-"));
  try {
    for (const dir of BLOCKED_DIRS) {
      assert.throws(() => resolveWorkspacePath(`${dir}/config.json`, root), /path_forbidden/, dir);
      assert.throws(() => resolveWorkspacePath(`sub/${dir}`, root), /path_forbidden/, `sub/${dir}`);
    }
    for (const dir of FREE_DIRS) assert.doesNotThrow(() => resolveWorkspacePath(`${dir}/notes.md`, root), dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shell tripwire blocks a line naming an app-state folder and lets project names through", async () => {
  type Tool = { execute: (input: never, context: never) => unknown };
  const run = async (command: string) => (await (bash as unknown as Tool).execute({ command } as never, {} as never)) as { status?: string };
  for (const dir of BLOCKED_DIRS) {
    assert.equal((await run(`cat ~/${dir}/config.json`)).status, "blocked", dir);
    assert.equal((await run(`ls "$HOME/${dir}"`)).status, "blocked", `${dir} quoted`);
  }
  for (const dir of FREE_DIRS) {
    assert.notEqual((await run(`echo ~/Desktop/${dir}`)).status, "blocked", dir);
  }
});

test("the sandbox profile denies reads and writes of every app-state folder", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-stack-sb-"));
  try {
    for (const profile of [sandboxProfile(root), sandboxProfile(root, "folder"), sandboxProfile(root, "computer", true), sandboxProfile(null)]) {
      // The pattern for the dashed names (.useful-bot-dev, .useful-bot-dev-app).
      assert.ok(profile.includes('(deny file-write* (regex #"/\\.useful-bot-[^/]*($|/)"))'), "write deny for dashed names");
      assert.ok(profile.includes('(deny file-read* (regex #"/\\.useful-bot-[^/]*($|/)"))'), "read deny for dashed names");
      // And the original rule is still there.
      assert.ok(profile.includes('(deny file-write* (regex #"/\\.useful-bot($|[/.])"))'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the kernel refuses a write into every app-state folder and allows unrelated names", { skip: !darwin || !sandboxAvailable() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ub-stack-k-"));
  const confined = async (command: string) => {
    const args = confinedCommand(root, command);
    try {
      await execFileAsync(args[0], args.slice(1), { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } });
      return true;
    } catch {
      return false;
    }
  };
  try {
    for (const dir of BLOCKED_DIRS) {
      assert.equal(await confined(`mkdir ${dir}`), false, dir);
      assert.equal(existsSync(join(root, dir)), false, `${dir} was created`);
    }
    for (const dir of FREE_DIRS) {
      assert.equal(await confined(`mkdir ${dir}`), true, dir);
      assert.ok(statSync(join(root, dir)).isDirectory(), dir);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7b. The runtime install roots: service code and the eve session transcripts.

const SUPPORT = "Library/Application Support";
const RUNTIME_DIRS = ["Useful Bot", "Useful Bot Dev"];
const UNRELATED_SUPPORT = ["Claude", "Useful Botany", "Code"];

test("a grant on a runtime install folder, in either stack, is refused; other Application Support folders are fine", () => {
  for (const dir of RUNTIME_DIRS) {
    for (const spelled of [dir, dir.toUpperCase(), dir.toLowerCase()]) {
      for (const tail of ["", "/app", "/app/.eve/sessions"]) {
        assert.equal(isGrantableRootPath(`/Users/me/${SUPPORT}/${spelled}${tail}`), false, `${spelled}${tail}`);
      }
    }
    assert.equal(isGrantableRootPath(`/Users/me/${SUPPORT.toUpperCase()}/${dir}/app`), false, `${dir} upper support`);
  }
  for (const dir of UNRELATED_SUPPORT) assert.equal(isGrantableRootPath(`/Users/me/${SUPPORT}/${dir}`), true, dir);
  assert.equal(isGrantableRootPath(`/Users/me/${SUPPORT}`), true, "the parent alone is not an app store");
  assert.equal(isGrantableRootPath("/Users/me/Desktop/Useful Bot"), true, "a project called Useful Bot");
  assert.equal(isGrantableRootPath("/Users/me/Documents/Useful Bot Dev"), true, "the media folders are not stores");
});

test("read_file, write and list paths into a runtime install folder are refused, and a symlink into one", async () => {
  const home = realpathSync(tempHome());
  try {
    for (const dir of RUNTIME_DIRS) mkdirSync(join(home, SUPPORT, dir, "app", ".eve"), { recursive: true });
    mkdirSync(join(home, SUPPORT, "Claude"), { recursive: true });
    mkdirSync(join(home, SUPPORT, "Useful Botany"), { recursive: true });
    writeFileSync(join(home, SUPPORT, "Claude", "note.txt"), "fine");
    writeFileSync(join(home, SUPPORT, "Useful Botany", "note.txt"), "fine");
    writeFileSync(join(home, SUPPORT, "Useful Bot", "app", ".eve", "session.json"), "transcript");
    symlinkSync(join(home, SUPPORT, "Useful Bot", "app"), join(home, "into-daily"));
    symlinkSync(join(home, SUPPORT, "Useful Bot Dev"), join(home, "into-dev"));

    for (const dir of RUNTIME_DIRS) {
      for (const spelled of [dir, dir.toUpperCase(), dir.toLowerCase()]) {
        for (const path of [`${SUPPORT}/${spelled}`, `${SUPPORT}/${spelled}/app/.eve/session.json`, `${SUPPORT.toLowerCase()}/${spelled}/new.txt`, `./${SUPPORT}//${spelled}/../${spelled}/app`]) {
          assert.throws(() => resolveWorkspacePath(path, home), /path_forbidden/, path);
        }
      }
    }
    for (const dir of UNRELATED_SUPPORT) assert.doesNotThrow(() => resolveWorkspacePath(`${SUPPORT}/${dir}/note.txt`, home), dir);

    // A symlink inside the workspace never carries a path through.
    for (const path of ["into-daily/.eve/session.json", "into-dev/app", "into-daily"]) {
      assert.throws(() => resolveWorkspacePath(path, home), /path_symlink|path_forbidden/, path);
    }
    // A root that is itself inside an install folder, however it was reached.
    assert.throws(() => resolveWorkspacePath("app/.eve/session.json", join(home, SUPPORT, "Useful Bot")), /path_forbidden/);
    assert.throws(() => assertSafeRoot(join(home, SUPPORT, "Useful Bot", "app")), /workspace_path_forbidden/);
    assert.throws(() => assertSafeRoot(join(home, "into-daily")), /workspace_path_forbidden|workspace_root_symlink/);

    // The tools themselves, with the working root pinned the way the shell does it.
    type Tool = { execute: (input: never, context: never) => unknown };
    await withEnvAsync({ UB_WORKSPACE_ROOT: home, UB_APPROVALS_PATH: join(home, "approvals.json") }, async () => {
      for (const path of [`${SUPPORT}/Useful Bot/app/.eve/session.json`, `${SUPPORT}/useful bot dev/app`, "into-daily/.eve/session.json"]) {
        assert.throws(() => (readFile as unknown as Tool).execute({ path } as never, {} as never), /path_forbidden|path_symlink/, `read ${path}`);
        assert.throws(() => (listDir as unknown as Tool).execute({ path } as never, {} as never), /path_forbidden|path_symlink/, `list ${path}`);
        await assert.rejects(
          approvedWrite({ path, content: "x", expectedSha256: null, sessionId: "", turnId: "t", toolCallId: "c", autoDecision: "approve" }),
          /path_forbidden|path_symlink/,
          `write ${path}`,
        );
      }
      const fine = (await (readFile as unknown as Tool).execute({ path: `${SUPPORT}/Claude/note.txt` } as never, {} as never)) as { text: string };
      assert.match(fine.text, /fine/);
    });
    assert.equal(readFileSync(join(home, SUPPORT, "Useful Bot", "app", ".eve", "session.json"), "utf8"), "transcript");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the shell tripwire blocks a line naming a runtime install folder, however the spaces are written", async () => {
  type Tool = { execute: (input: never, context: never) => unknown };
  const run = async (command: string) => (await (bash as unknown as Tool).execute({ command } as never, {} as never)) as { status?: string };
  for (const line of [
    "cat ~/Library/Application\\ Support/Useful\\ Bot/app/.eve/session.json",
    'ls "$HOME/Library/Application Support/Useful Bot Dev"',
    "ls '/Users/me/Library/Application Support/USEFUL BOT/app'",
    "cat ~/library/application\\ support/useful\\ bot\\ dev/app/x",
    'tar c "/Users/me/Library/Application Support/Useful Bot"',
  ]) {
    assert.equal((await run(line)).status, "blocked", line);
    assert.equal(mentionsAppState(line), true, line);
  }
  for (const line of [
    "ls ~/Library/Application\\ Support/Claude",
    'ls "$HOME/Library/Application Support/Useful Botany"',
    "ls ~/Library/Application\\ Support",
    "echo ~/Desktop/Useful\\ Bot",
  ]) {
    assert.notEqual((await run(line)).status, "blocked", line);
    assert.equal(mentionsAppState(line), false, line);
  }
});

test("the sandbox profile denies reads and writes of both runtime install folders, case-insensitively", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-stack-rt-"));
  const ci = (text: string) => text.replace(/[A-Za-z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
  const pattern = `/${ci("Library")}/${ci("Application")} ${ci("Support")}/${ci("Useful")} ${ci("Bot")}( ${ci("Dev")})?($|/)`;
  try {
    for (const profile of [sandboxProfile(root), sandboxProfile(root, "folder"), sandboxProfile(root, "computer", true), sandboxProfile(null)]) {
      assert.ok(profile.includes(`(deny file-write* (regex #"${pattern}"))`), "write deny");
      assert.ok(profile.includes(`(deny file-read* (regex #"${pattern}"))`), "read deny");
    }
    assert.ok(PROTECTED_NAMES.includes("Library/Application Support/Useful Bot"));
    assert.ok(PROTECTED_NAMES.includes("Library/Application Support/Useful Bot Dev"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the kernel refuses reads and writes in both runtime install folders, through a symlink too", { skip: !darwin || !sandboxAvailable() }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ub-stack-krt-")));
  const confined = async (command: string) => {
    const args = confinedCommand(root, command);
    try {
      await execFileAsync(args[0], args.slice(1), { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } });
      return true;
    } catch {
      return false;
    }
  };
  try {
    for (const dir of [...RUNTIME_DIRS, ...UNRELATED_SUPPORT]) {
      mkdirSync(join(root, SUPPORT, dir, "app"), { recursive: true });
      writeFileSync(join(root, SUPPORT, dir, "app", "note.txt"), "x");
    }
    symlinkSync(join(root, SUPPORT, "Useful Bot", "app"), join(root, "link-daily"));
    symlinkSync(join(root, SUPPORT, "Useful Bot Dev", "app"), join(root, "link-dev"));
    for (const dir of RUNTIME_DIRS) {
      assert.equal(await confined(`cat "${SUPPORT}/${dir}/app/note.txt"`), false, `read ${dir}`);
      assert.equal(await confined(`cat "${SUPPORT}/${dir.toUpperCase()}/app/note.txt"`), false, `read ${dir} upper`);
      assert.equal(await confined(`echo y > "${SUPPORT}/${dir}/app/new.txt"`), false, `write ${dir}`);
      assert.equal(existsSync(join(root, SUPPORT, dir, "app", "new.txt")), false, `${dir} was written`);
    }
    assert.equal(await confined("cat link-daily/note.txt"), false, "read through a symlink");
    assert.equal(await confined("echo y > link-dev/new.txt"), false, "write through a symlink");
    assert.equal(existsSync(join(root, SUPPORT, "Useful Bot Dev", "app", "new.txt")), false);
    for (const dir of UNRELATED_SUPPORT) {
      assert.equal(await confined(`cat "${SUPPORT}/${dir}/app/note.txt"`), true, `read ${dir}`);
      assert.equal(await confined(`echo y > "${SUPPORT}/${dir}/app/new.txt"`), true, `write ${dir}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7c. The iOS gate script never reaches a dev stack's eve.

test("ios-pairing-gate.sh stops only the eve that listens on the daily eve port", () => {
  const script = readFileSync(join(ROOT, "scripts/ios-pairing-gate.sh"), "utf8");
  assert.doesNotMatch(script, /pkill\s+-f/, "a pattern kill reaches every stack's eve");
  assert.doesNotMatch(script, /pgrep\s+-f\s+"service\.mjs eve"/, "a pattern lookup reaches every stack's supervisor");
  const stopEve = script.slice(script.indexOf("stop_eve()"), script.indexOf("start_eve()"));
  assert.match(stopEve, /lsof -ti tcp:4321 -sTCP:LISTEN/);
  assert.match(stopEve, /ps -o ppid=/, "the supervisor is found as the listener's ancestor");
  const syntax = spawnSync("/bin/bash", ["-n", join(ROOT, "scripts/ios-pairing-gate.sh")], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

// ---------------------------------------------------------------------------
// 8. Guard: runtime code reads ports, the Keychain prefix and the state root
//    from the one config module, nowhere else.

// Files that legitimately name a daily literal, and why.
const ALLOW = new Set([
  "shared/stack.ts", // the one place
  // launchd service labels and a --state-root default for the LaunchAgent plists,
  // not Keychain items; the daily plists are a separate install path.
  "shared/launchd-render.ts",
  "scripts/render-launchd.mjs",
  // A staged fake HOME for the runtime smoke test, which pins every path itself.
  "scripts/smoke-runtime.mjs",
]);
const SCAN_DIRS = ["agent", "shared", "router/src", "web/app", "web/lib", "scripts"];
const EXTS = /\.(ts|tsx|mjs|js)$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(rel, out);
    else if (EXTS.test(entry.name)) out.push(rel);
  }
  return out;
}

/** Comment text is prose, not code: drop whole-line comments and ` // ` tails. */
function codeLines(text: string): Array<[number, string]> {
  const lines: Array<[number, string]> = [];
  let inBlock = false;
  text.split("\n").forEach((raw, index) => {
    let line = raw;
    if (inBlock) {
      if (line.includes("*/")) {
        inBlock = false;
        line = line.slice(line.indexOf("*/") + 2);
      } else {
        return;
      }
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlock = true;
      return;
    }
    lines.push([index + 1, line.replace(/\s\/\/.*$/, "")]);
  });
  return lines;
}

test("no runtime code carries a daily port, Keychain name or state path outside shared/stack.ts", () => {
  const rules: Array<[string, RegExp]> = [
    ["a service port", /\b43(19|20|21)\b/],
    ["a Keychain name", /com\.usefulbot\./],
    ["the state folder", /\.useful-bot(?![a-z0-9_])/i],
  ];
  const offenders: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(dir)) {
      if (ALLOW.has(file)) continue;
      for (const [lineNo, line] of codeLines(readFileSync(join(ROOT, file), "utf8"))) {
        for (const [label, pattern] of rules) {
          if (pattern.test(line)) offenders.push(`${file}:${lineNo} ${label}: ${line.trim().slice(0, 100)}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `daily literals outside shared/stack.ts:\n${offenders.join("\n")}`);
  for (const file of ALLOW) assert.ok(existsSync(join(ROOT, file)), `allowlisted file is gone: ${file}`);
});
