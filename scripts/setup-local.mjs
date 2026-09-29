#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const [NODE_MAJOR, NODE_MINOR, NODE_PATCH] = process.versions.node.split(".").map(Number);
if (NODE_MAJOR !== 24 || NODE_MINOR < 11 || (NODE_MINOR === 11 && NODE_PATCH < 1)) {
  process.stderr.write(`setup refuses Node ${process.versions.node}, need >=24.11.1 <25\n`);
  process.exit(2);
}

process.umask(0o077);

// Every app token this setup mints: a config row (digest only) and the
// Keychain item that holds the value. The channel secret has no config row,
// the web and eve services read it from Keychain to sign and verify channel
// JWTs. The reviewer credential is the only one that may carry the reviewer
// alias, so without it "ask the reviewer" reports reviewer_unconfigured.
const TOKEN_CREDENTIALS = [
  { id: "device-desktop", kind: "device", callerId: "desktop", profile: "desktop", keychain: "com.usefulbot.device.desktop" },
  { id: "router-desktop", kind: "router", callerId: "desktop", profile: "desktop", keychain: "com.usefulbot.router.desktop" },
  { id: "router-ops", kind: "router", callerId: "ops", profile: "ops", keychain: "com.usefulbot.router.ops" },
  { id: "router-reviewer", kind: "router", callerId: "reviewer", profile: "reviewer", keychain: "com.usefulbot.router.reviewer" },
];
// The owner-phone credential (spec S7/§4.1): minted by --pair-phone only, so a
// plain setup or --add-missing never creates phone authority by accident.
const PHONE_CREDENTIAL = { id: "device-phone", kind: "device", callerId: "phone", profile: "phone", keychain: "com.usefulbot.device.phone" };
// Phone rows match by kind+callerId, never by id: the id is unique per mint
// so a session bound to a rotated-away row resolves to nothing (S9).
const isPhoneRow = (row) => row && row.kind === PHONE_CREDENTIAL.kind && row.callerId === PHONE_CREDENTIAL.callerId;
const mintPhone = () => mint({ ...PHONE_CREDENTIAL, id: `${PHONE_CREDENTIAL.id}-${randomBytes(6).toString("hex")}` });
const CHANNEL_KEYCHAIN = "com.usefulbot.channel.desktop";
const KEYCHAIN_ITEMS = [...TOKEN_CREDENTIALS.map((cred) => cred.keychain), CHANNEL_KEYCHAIN];

function digest(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// A bare `-w` makes security prompt for the value and a retype, both read
// from stdin, and on a mismatch it stores an empty password and still exits
// 0: a token piped once ended up as an empty item. Command mode (-i) takes
// the whole command on stdin instead, so the value never reaches argv and a
// failure is a non-zero status. Tokens are base64url, so no quoting is needed.
function putKeychain(service, token) {
  const input = Buffer.from(`add-generic-password -U -s ${service} -a useful-bot -w ${token}\n`, "utf8");
  const result = spawnSync("/usr/bin/security", ["-i"], { input, stdio: ["pipe", "ignore", "ignore"] });
  input.fill(0);
  if (result.status !== 0) {
    throw new Error(service);
  }
}

// The stored value, consumed in memory and never printed; null when the item
// is absent or empty. An empty value is what the old prompt driven write left
// behind, and a service reading it gets nothing.
function readKeychain(service) {
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", "useful-bot", "-w"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value.length > 0 ? value : null;
}

function hasKeychain(service) {
  return readKeychain(service) !== null;
}

function deleteKeychain(service) {
  spawnSync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", "useful-bot"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

// True when the Keychain value is the one the config row was minted from. A
// mismatch (an item rewritten by a put that then failed later in the batch,
// or an empty item) is as unusable as a missing one and is re-minted.
function keychainMatches(service, row) {
  const value = readKeychain(service);
  return value !== null && digest(value) === row.sha256;
}

function flagValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

const rotate = process.argv.includes("--rotate");
// Mints only the credentials an existing install lacks (a config row without
// its Keychain item, or neither), leaving every other token as it is. This is
// how an install from before the reviewer credential picks it up without a
// full --rotate, which would also invalidate the device and desktop tokens.
const addMissing = process.argv.includes("--add-missing");
const pairPhone = process.argv.includes("--pair-phone");
const revokePhone = process.argv.includes("--revoke-phone");
const rotatePhone = process.argv.includes("--rotate-phone");
// `--print-pairing` is the standalone reveal op; bare `--print` modifies
// --pair-phone/--rotate-phone to also print the payload once.
const printOnly = process.argv.includes("--print-pairing");
const printFlag = process.argv.includes("--print");
const hostOverride = flagValue("--host");
const root = join(homedir(), ".useful-bot");
const configPath = join(root, "config.json");

const fail = (payload) => {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exit(payload.exit ?? 1);
};

const phoneOps = [pairPhone, revokePhone, rotatePhone, printOnly].filter(Boolean).length;
if (rotate && addMissing) {
  fail({ error: "conflicting_flags", flags: ["--rotate", "--add-missing"], exit: 2 });
}
if (phoneOps > 0 && (rotate || addMissing)) {
  fail({ error: "conflicting_flags", flags: ["--rotate/--add-missing", "--pair-phone/--revoke-phone/--rotate-phone/--print-pairing"], exit: 2 });
}
if (phoneOps > 1) {
  fail({ error: "conflicting_flags", flags: ["--pair-phone", "--revoke-phone", "--rotate-phone", "--print-pairing"], exit: 2 });
}
if (printFlag && !pairPhone && !rotatePhone) {
  fail({ error: "conflicting_flags", hint: "--print pairs only with --pair-phone or --rotate-phone; use --print-pairing for an existing credential", exit: 2 });
}
if (hostOverride && !pairPhone && !printOnly && !rotatePhone) {
  fail({ error: "conflicting_flags", hint: "--host belongs to the pairing payloads", exit: 2 });
}

const existingItems = KEYCHAIN_ITEMS.filter(hasKeychain);
if (!rotate && !addMissing && phoneOps === 0 && (existsSync(configPath) || existingItems.length > 0)) {
  fail({
    error: "already_configured",
    config: existsSync(configPath) ? configPath : null,
    keychainItems: existingItems,
    hint: "rerun with --add-missing to mint only what is absent, or --rotate to replace every credential",
  });
}

function readExistingConfig() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    const reason = err instanceof Error && err.code === "ENOENT" ? "not_configured" : "config_unreadable";
    // Fresh setup refuses while any Keychain item exists, so a lost config
    // with items left behind can only be rebuilt by --rotate.
    const hint = existingItems.length > 0 ? "rerun with --rotate to rebuild the config" : "run setup without flags first";
    fail({ error: reason, config: configPath, hint });
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.credentials)) {
    fail({ error: "config_invalid", config: configPath });
  }
  return parsed;
}

// The old config stays in place until the new secrets are stored: a failed
// put must leave the previous config untouched.
mkdirSync(root, { recursive: true, mode: 0o700 });
chmodSync(root, 0o700);

const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

function mint(cred) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    keychain: cred.keychain,
    row: { id: cred.id, kind: cred.kind, sha256: digest(token), callerId: cred.callerId, profile: cred.profile, expiresAt: future, revokedAt: null },
  };
}

function writeConfig(config) {
  const tmpConfigPath = `${configPath}.tmp.${process.pid}`;
  writeFileSync(tmpConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmpConfigPath, 0o600);
  renameSync(tmpConfigPath, configPath);
  chmodSync(configPath, 0o600);
}

/**
 * Canonical https origin — the same rule shared/runtime.ts's validateTailnet
 * applies at load (scheme https, non-empty host, no credentials, path, query
 * or fragment, no port but the implicit 443). The string form is what the
 * Origin header carries, so the stored value must equal it exactly.
 */
function canonicalHttpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname) return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  if (url.port && url.port !== "443") return null;
  return url.origin;
}

/**
 * The tailnet record (spec S2): fields come from flags, then the existing
 * config, then interactive prompts — the last resort so an automated caller
 * without a TTY fails loudly instead of hanging.
 */
async function collectTailnet(existing) {
  const flagMap = {
    httpsOrigin: flagValue("--tailnet-origin"),
    userLogin: flagValue("--tailnet-login"),
    phoneIpv4: flagValue("--phone-ipv4"),
    phoneIpv6: flagValue("--phone-ipv6"),
    macIdentity: flagValue("--mac-identity"),
  };
  const merged = {};
  for (const [field, value] of Object.entries(flagMap)) {
    merged[field] = value || existing?.[field] || null;
  }
  const missing = Object.entries(merged).filter(([, value]) => !value).map(([field]) => field);
  if (missing.length > 0) {
    if (!process.stdin.isTTY) {
      fail({
        error: "tailnet_fields_required",
        missing,
        hint: "pass --tailnet-origin, --tailnet-login, --phone-ipv4, --phone-ipv6 and --mac-identity, or run interactively to be prompted",
      });
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      for (const field of missing) {
        merged[field] = (await new Promise((resolve) => rl.question(`${field}: `, resolve))).trim() || null;
      }
    } finally {
      rl.close();
    }
  }
  const stillMissing = Object.entries(merged).filter(([, value]) => !value).map(([field]) => field);
  if (stillMissing.length > 0) {
    fail({ error: "tailnet_fields_required", missing: stillMissing });
  }
  // The loader's rule, enforced here so a plausible operator form never
  // lands as a config every request then 401s against (the runtime
  // validator throws on load, emptying every credential check): the
  // httpsOrigin must be the canonical https origin an Origin header
  // carries. Canonicalize the harmless variants — trailing slash, an
  // explicit :443, uppercase host — and refuse the rest naming the field.
  const canonical = canonicalHttpsOrigin(merged.httpsOrigin);
  if (!canonical) {
    fail({
      error: "tailnet_origin_invalid",
      field: "httpsOrigin",
      hint: "expected a bare https origin like https://<mac>.<tailnet>.ts.net — no http, path, query, credentials or non-443 port",
    });
  }
  merged.httpsOrigin = canonical;
  return merged;
}

function pairingPayload(config, { host } = {}) {
  const token = readKeychain(PHONE_CREDENTIAL.keychain);
  if (!token) {
    fail({ error: "phone_token_missing", hint: "pair first with --pair-phone" });
  }
  const tailnet = config.tailnet;
  const resolved = host || tailnet?.httpsOrigin;
  if (!resolved) {
    fail({ error: "pairing_host_missing", hint: "configure tailnet.httpsOrigin or pass --host http://127.0.0.1:4320 for the simulator" });
  }
  return {
    v: 1,
    host: resolved,
    token,
    name: tailnet?.macIdentity || "your Mac",
  };
}

function printPayload(config, { host } = {}) {
  const payload = pairingPayload(config, { host });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.stderr.write("warning: the pairing token is now in this terminal's scrollback; clear it or rotate with --rotate-phone\n");
}

async function main() {
  if (phoneOps > 0) {
    const config = readExistingConfig();
    const phoneRows = () => config.credentials.filter(isPhoneRow);
    const livePhoneRow = () => phoneRows().find((row) => row.revokedAt === null);

    if (printOnly) {
      if (!livePhoneRow()) fail({ error: "not_paired", hint: "run --pair-phone first" });
      printPayload(config, { host: hostOverride });
      process.exit(0);
    }

    if (revokePhone) {
      const now = new Date().toISOString();
      let touched = false;
      for (const row of phoneRows()) {
        if (row.revokedAt === null) {
          row.revokedAt = now;
          touched = true;
        }
      }
      config.phoneEnabled = false;
      deleteKeychain(PHONE_CREDENTIAL.keychain);
      writeConfig(config);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        revoked: touched,
        phoneEnabled: false,
        config: configPath,
        note: "phone sessions fail credential_invalid on their next request; no restart needed",
      })}\n`);
      process.exit(0);
    }

    if (pairPhone && livePhoneRow()) {
      fail({ error: "already_paired", hint: "use --rotate-phone to replace the phone credential, or --revoke-phone first" });
    }

    // --pair-phone and --rotate-phone share the mint path: a new token in the
    // Keychain, the old row(s) revoked in place, everything else untouched.
    const tailnet = await collectTailnet(config.tailnet);
    const entry = mintPhone();
    const now = new Date().toISOString();
    try {
      putKeychain(entry.keychain, entry.token);
    } catch {
      fail({ error: "keychain_write_failed", item: entry.keychain });
    }
    for (const row of phoneRows()) {
      if (row.revokedAt === null) row.revokedAt = now;
    }
    config.credentials.push(entry.row);
    config.phoneEnabled = true;
    config.tailnet = tailnet;
    writeConfig(config);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      paired: true,
      rotated: rotatePhone,
      phoneEnabled: true,
      expiresAt: entry.row.expiresAt,
      config: configPath,
      reveal: "Mac app Settings > Devices > Show pairing QR",
    })}\n`);
    if (printFlag) {
      printPayload(config, { host: hostOverride });
    }
    process.exit(0);
  }

  let config;
  let minted;
  if (addMissing) {
    config = readExistingConfig();
    // A revoked row is a decision, not a gap: it stays as it is and is never
    // re-minted here (that is what --rotate is for). Only an id with no row at
    // all, an active row whose Keychain value no longer matches its digest, or
    // an active row past its expiry counts as missing.
    const rows = config.credentials.filter((row) => row && typeof row.id === "string");
    const known = new Set(rows.map((row) => row.id));
    const active = new Map(rows.filter((row) => row.revokedAt === null).map((row) => [row.id, row]));
    minted = TOKEN_CREDENTIALS
      .filter((cred) => {
        if (!known.has(cred.id)) return true;
        const row = active.get(cred.id);
        if (row === undefined) return false;
        if (!keychainMatches(cred.keychain, row)) return true;
        // Credentials expire 30 days after setup; an expired-but-matching row
        // is refreshed here so the install does not need a full --rotate.
        const expires = Date.parse(row.expiresAt);
        return Number.isNaN(expires) || expires <= Date.now();
      })
      .map(mint);
    if (!hasKeychain(CHANNEL_KEYCHAIN)) {
      minted.push({ token: randomBytes(32).toString("base64url"), keychain: CHANNEL_KEYCHAIN, row: null });
    }
    if (minted.length === 0) {
      process.stdout.write(`${JSON.stringify({ ok: true, added: [], config: configPath })}\n`);
      process.exit(0);
    }
    const replaced = new Set(minted.filter((entry) => entry.row).map((entry) => entry.row.id));
    config.credentials = [
      ...config.credentials.filter((row) => !(row && row.revokedAt === null && replaced.has(row.id))),
      ...minted.filter((entry) => entry.row).map((entry) => entry.row),
    ];
  } else if (rotate) {
    const previous = existsSync(configPath) ? readExistingConfig() : null;
    const phoneActive = previous?.credentials?.some?.(
      (row) => isPhoneRow(row) && row.revokedAt === null
    );
    minted = [
      ...TOKEN_CREDENTIALS.map(mint),
      // --rotate covers the phone credential too when one is live, and keeps
      // the phone enrollment as it was (S7): a rotation must not silently
      // switch phoneEnabled off or lose the tailnet record.
      ...(phoneActive ? [mintPhone()] : []),
      { token: randomBytes(32).toString("base64url"), keychain: CHANNEL_KEYCHAIN, row: null },
    ];
    config = {
      schemaVersion: 1,
      phoneEnabled: previous?.phoneEnabled === true,
      tailnet: previous?.tailnet ?? null,
      sandbox: { backend: "just-bash", evidenceId: "s3-non-vm-default", imageDigest: null },
      goBalanceDisabledConfirmedAt: new Date().toISOString(),
      searchKeyRequired: false,
      credentials: minted.filter((entry) => entry.row).map((entry) => entry.row),
    };
  } else {
    minted = [
      ...TOKEN_CREDENTIALS.map(mint),
      { token: randomBytes(32).toString("base64url"), keychain: CHANNEL_KEYCHAIN, row: null },
    ];
    config = {
      schemaVersion: 1,
      phoneEnabled: false,
      tailnet: null,
      sandbox: { backend: "just-bash", evidenceId: "s3-non-vm-default", imageDigest: null },
      goBalanceDisabledConfirmedAt: new Date().toISOString(),
      searchKeyRequired: false,
      credentials: minted.filter((entry) => entry.row).map((entry) => entry.row),
    };
  }
  const tmpConfigPath = `${configPath}.tmp.${process.pid}`;
  writeFileSync(tmpConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmpConfigPath, 0o600);

  try {
    for (const entry of minted) {
      putKeychain(entry.keychain, entry.token);
    }
  } catch (err) {
    try { unlinkSync(tmpConfigPath); } catch { /* ignore */ }
    const item = err instanceof Error ? err.message : "unknown";
    fail({ error: "keychain_write_failed", item });
  }

  let backup = null;
  if ((rotate || addMissing) && existsSync(configPath)) {
    backup = `${configPath}.bak.${Date.now()}`;
    renameSync(configPath, backup);
  }
  renameSync(tmpConfigPath, configPath);
  chmodSync(configPath, 0o600);

  const connectionsPath = join(homedir(), ".useful-bot/connections.json");
  mkdirSync(dirname(connectionsPath), { recursive: true, mode: 0o700 });
  let connections = { schemaVersion: 1, connections: [], updatedAt: null };
  if (existsSync(connectionsPath)) {
    try {
      connections = JSON.parse(readFileSync(connectionsPath, "utf8"));
      if (!connections || connections.schemaVersion !== 1 || !Array.isArray(connections.connections)) {
        connections = { schemaVersion: 1, connections: [], updatedAt: null };
      }
    } catch {
      connections = { schemaVersion: 1, connections: [], updatedAt: null };
    }
  }
  const hasExcalidraw = connections.connections.some((row) => (
    row && (row.id === "excalidraw" || row.url === "https://mcp.excalidraw.com/mcp")
  ));
  if (!hasExcalidraw) {
    connections.connections.push({
      id: "excalidraw",
      kind: "mcp",
      name: "Excalidraw",
      url: "https://mcp.excalidraw.com/mcp",
      description: "Official Excalidraw MCP App. Draw hand-drawn diagrams in the chat. Call read_me once, then create_view with Excalidraw elements.",
      authKind: "none",
      authHeader: null,
      toolsAllow: ["read_me", "create_view"],
      createdAt: new Date().toISOString(),
    });
    connections.updatedAt = new Date().toISOString();
    writeFileSync(connectionsPath, `${JSON.stringify(connections)}\n`, { mode: 0o600 });
    chmodSync(connectionsPath, 0o600);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    rotated: rotate,
    added: addMissing ? minted.map((entry) => entry.keychain) : undefined,
    backup,
    config: configPath,
    keychainItems: KEYCHAIN_ITEMS,
    reveal: "Keychain Access",
    manual: "install com.usefulbot.opencode-go yourself (see README)",
    restart: "restart the router, eve and web services: the router reloads the credential table and the other two read the tokens at boot",
  })}\n`);
}

await main();
