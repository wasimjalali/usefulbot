// node:child_process as setup-local sees it under the test hooks: every call
// to /usr/bin/security runs the stub script in STUB_SECURITY_BIN instead. A
// run without that variable throws rather than fall through to the real one.
import * as real from "node:child_process";

export const securityStubbed = true;
const SECURITY = "/usr/bin/security";

// A bare `security` (found through PATH) or a shell string would slip past
// the exact-path redirect, so those fail loudly instead.
function redirect(command) {
  if (command === "security") throw new Error("setup-local called security through PATH; the stub only redirects /usr/bin/security");
  if (command !== SECURITY) return command;
  const stub = process.env.STUB_SECURITY_BIN;
  if (!stub) throw new Error("STUB_SECURITY_BIN is not set; refusing to run the real security tool");
  return stub;
}

export function spawnSync(command, ...rest) {
  return real.spawnSync(redirect(command), ...rest);
}

export function spawn(command, ...rest) {
  return real.spawn(redirect(command), ...rest);
}

export function execFileSync(command, ...rest) {
  return real.execFileSync(redirect(command), ...rest);
}

export function execFile(command, ...rest) {
  return real.execFile(redirect(command), ...rest);
}

function refuseShell(name) {
  return () => {
    throw new Error(`setup-local used child_process.${name}; the Keychain stub can't see into a shell string`);
  };
}

export const exec = refuseShell("exec");
export const execSync = refuseShell("execSync");
