#!/usr/bin/env node
// Builds a release of the macOS app: the app with the services it carries, a
// zip signed for Sparkle, the one-item appcast that points at it, and a DMG
// with the drag-to-Applications window for browser downloads.
//
//   npm run release:mac -- --version 0.3.0 [--feed-url URL] [--download-base URL] [--out DIR] [--allow-dirty]
//
// A test machine without the real key signs with its own (--ed-account and
// --ed-public-key from its `generate_keys`); those builds can never update a
// real install, whose app only trusts ED_PUBLIC_KEY.
//
// Nothing is uploaded. Publishing is putting the zip, the DMG, appcast.xml and install.sh where
// --download-base and --feed-url say (docs/distribution.md).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASES = "https://github.com/wasimjalali/useful-bot-releases/releases";
// The public half of the update signing key. The private half lives only in
// the release machine's Keychain (account "useful-bot") and its backup.
const ED_PUBLIC_KEY = "11z765AdjQEGbUvVpESlqpz5OLouCcCzucHfPpuNC0M=";
const ZIP = "Useful-Bot-macOS.zip";
const SPARKLE_BIN = path.join(ROOT, "macos/.build/artifacts/sparkle/Sparkle/bin");
const DMG = "Useful-Bot-macOS.dmg";
// dmgbuild writes the DMG window's .DS_Store itself, so no Finder scripting.
// It lives in a venv under macos/.build, never in the system Python.
const DMG_PACKAGES = ["dmgbuild==1.6.7", "ds_store==1.3.3", "mac_alias==2.2.3"];
const VOLUME = "Useful Bot";
const DMG_VENV = path.join(ROOT, "macos/.build/dmg-venv");

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    "feed-url": { type: "string", default: `${RELEASES}/latest/download/appcast.xml` },
    "download-base": { type: "string" },
    out: { type: "string", default: path.join(ROOT, "macos/dist/release") },
    "allow-dirty": { type: "boolean", default: false },
    "ed-account": { type: "string", default: "useful-bot" },
    "ed-public-key": { type: "string", default: ED_PUBLIC_KEY },
  },
});
const version = values.version;
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  process.stderr.write("usage: release-mac.mjs --version X.Y.Z [--feed-url URL] [--download-base URL] [--out DIR] [--allow-dirty]\n");
  process.exit(2);
}
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
if (!values["allow-dirty"] && git("status", "--porcelain", "--untracked-files=no") !== "") {
  process.stderr.write("the tree has uncommitted changes; commit them or pass --allow-dirty for a test build\n");
  process.exit(1);
}
// Sparkle compares CFBundleVersion, so it must only ever grow: the commit count does.
const build = git("rev-list", "--count", "HEAD");
const downloadBase = values["download-base"] ?? `${RELEASES}/download/v${version}`;

// The key the app will trust must be the key the zip is signed with, or no
// update from this release could ever install. Checked before the long build.
// Sparkle's tools come with the Swift package; a fresh checkout has not fetched it yet.
if (!existsSync(path.join(SPARKLE_BIN, "generate_keys"))) {
  execFileSync("swift", ["package", "resolve"], { cwd: path.join(ROOT, "macos"), stdio: "inherit" });
}
const accountKey = execFileSync(path.join(SPARKLE_BIN, "generate_keys"), ["--account", values["ed-account"], "-p"], { encoding: "utf8" }).trim();
if (accountKey !== values["ed-public-key"]) {
  process.stderr.write(`the Keychain key for account "${values["ed-account"]}" is not the public key given (${values["ed-public-key"]})\n`);
  process.exit(1);
}
// The DMG tool, fetched once, before the long build. dmgbuild needs Python
// 3.10 or later; the Command Line Tools' python3 is 3.9.
const pyVersion = (python) => execFileSync(python, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" }).trim();
const pyOk = (v) => { const [major, minor] = v.split(".").map(Number); return major > 3 || (major === 3 && minor >= 10); };
// A venv made by an older Python, or one that no longer runs (its Python
// was upgraded or removed), is made again.
if (existsSync(DMG_VENV)) {
  let venvOk = false;
  try { venvOk = pyOk(pyVersion(path.join(DMG_VENV, "bin/python"))); } catch {}
  if (!venvOk) rmSync(DMG_VENV, { recursive: true, force: true });
}
if (!existsSync(path.join(DMG_VENV, "bin/python"))) {
  let system = "none";
  try { system = pyVersion("python3"); } catch {}
  if (!pyOk(system)) {
    process.stderr.write(`the DMG needs Python 3.10 or later for dmgbuild; python3 on PATH is ${system} (brew install python)\n`);
    process.exit(1);
  }
  execFileSync("python3", ["-m", "venv", DMG_VENV], { stdio: "inherit" });
}
// All three pinned: dmgbuild's own dependencies write the .DS_Store and alias.
execFileSync(path.join(DMG_VENV, "bin/pip"), ["install", "--quiet", "--disable-pip-version-check", ...DMG_PACKAGES], { stdio: "inherit" });
// dmgbuild mounts its working image by volume name. With a "Useful Bot"
// volume already mounted, its copy becomes "Useful Bot 1" and the window's
// background alias would point at that name.
if (existsSync(`/Volumes/${VOLUME}`)) {
  process.stderr.write(`/Volumes/${VOLUME} is mounted; eject it first (hdiutil detach "/Volumes/${VOLUME}")\n`);
  process.exit(1);
}
const out = path.resolve(values.out);
// Only ever replace an earlier release folder, never an arbitrary one: every
// entry in it must be a file a release writes.
const RELEASE_FILES = new Set([ZIP, DMG, "install.sh", "appcast.xml", ".DS_Store"]);
// A folder or link wearing a release file's name is foreign too: only plain files are replaced.
const foreign = existsSync(out)
  ? readdirSync(out, { withFileTypes: true }).filter((entry) => !RELEASE_FILES.has(entry.name) || !entry.isFile()).map((entry) => entry.name)
  : [];
if (foreign.length > 0) {
  process.stderr.write(`${out} holds files a release does not write (${foreign.join(", ")}); refusing to delete it\n`);
  process.exit(1);
}

execFileSync("sh", [path.join(ROOT, "macos/build-app.sh")], {
  cwd: path.join(ROOT, "macos"),
  stdio: "inherit",
  env: {
    ...process.env,
    UB_RELEASE: "1",
    UB_VERSION: version,
    UB_BUILD: build,
    UB_FEED_URL: values["feed-url"],
    UB_ED_PUBLIC_KEY: values["ed-public-key"],
  },
});

const APP = path.join(ROOT, "macos/dist/Useful Bot.app");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// The code directory hash, which names exactly one build of the app.
const cdhash = (app) => {
  const shown = spawnSync("codesign", ["-dvvv", app], { encoding: "utf8" });
  const match = /^CDHash=(\w+)$/m.exec(shown.stderr);
  if (!match) throw new Error(`codesign shows no CDHash for ${app}: ${shown.stderr}`);
  return match[1];
};
// A detach that fails is retried, then forced, and only logged: an error
// from the steps before it must be the one that reaches the terminal.
const detach = (mount) => {
  for (const args of [["detach", mount], ["detach", mount], ["detach", mount], ["detach", "-force", mount]]) {
    const result = spawnSync("hdiutil", args, { encoding: "utf8" });
    if (result.status === 0) return true;
    process.stderr.write(`hdiutil ${args.join(" ")}: ${(result.stderr || result.error?.message || "").trim()}\n`);
    sleep(1000);
  }
  return false;
};
// Ctrl-C (or a closed terminal) reaches the running tool too, which then
// fails, so the step throws and the cleanup below runs (unmount, scratch,
// the half-written release) before the error exits. Without these handlers
// Node would die on the spot and skip it. A signal that lands after the last
// step changes nothing: the release is whole, so its JSON prints and it exits 0.
// A signal sent to node alone (a bare `kill`) is only logged, and the release
// carries on to the end: stop it with Ctrl-C or by signalling the process group.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const onSignal = (signal) => process.stderr.write(`${signal}: finishing the current step, then cleaning up\n`);
for (const signal of SIGNALS) process.on(signal, onSignal);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const zip = path.join(out, ZIP);
const dmg = path.join(out, DMG);
let zipSha;
let dmgSha;
try {
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", APP, zip]);

  // `sign_update` prints the enclosure attributes: sparkle:edSignature="…" length="…".
  const signed = execFileSync(path.join(SPARKLE_BIN, "sign_update"), ["--account", values["ed-account"], zip], { encoding: "utf8" }).trim();
  if (!/sparkle:edSignature="[^"]+"/.test(signed)) throw new Error(`sign_update gave no signature: ${signed}`);

  // The DMG: the same app beside a link to /Applications over the brand
  // background (macos/dmg/). Built before the appcast and installer, so a
  // folder that has those is a whole release.
  const scratch = mkdtempSync(path.join(tmpdir(), "ub-dmg-"));
  const mount = path.join(scratch, "mount");
  let mounted = false;
  try {
    const font = path.join(ROOT, "brand/source/fonts/Inter-SemiBold.ttf");
    for (const [name, scale] of [["background.png", "1"], ["background@2x.png", "2"]]) {
      execFileSync("swift", [path.join(ROOT, "macos/dmg/background.swift"), path.join(scratch, name), scale, font], { stdio: "inherit" });
    }
    // Checked again here: a volume mounted during the long build would rename
    // dmgbuild's working copy (see the check before the build).
    if (existsSync(`/Volumes/${VOLUME}`)) throw new Error(`/Volumes/${VOLUME} was mounted during the build; eject it and run again`);
    execFileSync(path.join(DMG_VENV, "bin/dmgbuild"), [
      "-s", path.join(ROOT, "macos/dmg/settings.py"),
      "-D", `app=${APP}`,
      "-D", `background=${path.join(scratch, "background.png")}`,
      VOLUME, dmg,
    ], { stdio: "inherit" });

    // Mounted read-only and out of Finder's sight, checked, then let go.
    mkdirSync(mount);
    execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, dmg], { stdio: "ignore" });
    mounted = true;
    const layout = execFileSync(path.join(DMG_VENV, "bin/python"), [
      path.join(ROOT, "macos/dmg/verify.py"), mount, "Useful Bot.app", VOLUME, version, build,
    ], { encoding: "utf8" }).trim();
    process.stderr.write(`dmg layout: ${layout}\n`);
    const inDmg = path.join(mount, "Useful Bot.app");
    execFileSync("codesign", ["--verify", "--strict", "--deep", inDmg]);
    // The same build the zip carries, not a stale bundle.
    if (cdhash(inDmg) !== cdhash(APP)) throw new Error("the DMG's app is not the build in the zip (CDHash differs)");
    mounted = !detach(mount);
    if (mounted) throw new Error(`could not detach ${mount}`);
    const format = execFileSync("hdiutil", ["imageinfo", "-plist", dmg], { encoding: "utf8" });
    if (!/<key>Format<\/key>\s*<string>UDZO<\/string>/.test(format)) throw new Error("the DMG is not a compressed (UDZO) image");
  } finally {
    if (mounted) mounted = !detach(mount);
    // A volume still mounted there must not be walked into by rm.
    if (mounted) {
      process.stderr.write(`left ${mount} mounted; detach it by hand, then delete ${scratch}\n`);
    } else {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(`could not delete ${scratch}: ${error.message}\n`);
      }
    }
  }
  dmgSha = createHash("sha256").update(readFileSync(dmg)).digest("hex");

  const appcast = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Useful Bot</title>
    <item>
      <title>${version}</title>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <sparkle:version>${build}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <enclosure url="${downloadBase}/${ZIP}" type="application/octet-stream" ${signed} />
    </item>
  </channel>
</rss>
`;

  // The installer names this release's zip and its hash, and refuses anything else.
  zipSha = createHash("sha256").update(readFileSync(zip)).digest("hex");
  const installer = readFileSync(path.join(ROOT, "scripts/install.sh"), "utf8")
    .replace("@@ZIP_URL@@", `${downloadBase}/${ZIP}`)
    .replace("@@ZIP_SHA256@@", zipSha);
  if (installer.includes("@@ZIP_")) throw new Error("install.sh placeholders were not filled");
  writeFileSync(path.join(out, "install.sh"), installer, { mode: 0o755 });
  // Last: its presence marks a finished release folder.
  writeFileSync(path.join(out, "appcast.xml"), appcast);
} catch (error) {
  // Nothing half-built that looks publishable.
  rmSync(out, { recursive: true, force: true });
  throw error;
} finally {
  for (const signal of SIGNALS) process.off(signal, onSignal);
}

process.stdout.write(`${JSON.stringify({ version, build, zip, bytes: statSync(zip).size, sha256: zipSha, dmg, dmgBytes: statSync(dmg).size, dmgSha256: dmgSha, appcast: path.join(out, "appcast.xml"), feed: values["feed-url"] })}\n`);
