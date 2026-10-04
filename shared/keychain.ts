import { spawnSync } from "node:child_process";
import { keychainName, keychainServiceAllowed } from "./stack.ts";

/**
 * Generic-password Keychain items, same write path as setup-local.mjs:
 * `security -i` so the value never reaches argv. Tests inject a driver.
 */

export type KeychainDriver = {
  get(service: string): string | null;
  set(service: string, value: string): void;
  del(service: string): void;
};

const ACCOUNT = "useful-bot";

let driver: KeychainDriver | null = null;

export function setKeychainDriver(next: KeychainDriver | null): void {
  driver = next;
}

export function memoryKeychain(): KeychainDriver & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get(service) {
      return store.get(service) ?? null;
    },
    set(service, value) {
      store.set(service, value);
    },
    del(service) {
      store.delete(service);
    },
  };
}

/**
 * A service must be `<this stack's prefix>.<name>` (shared/stack.ts owns the
 * rule): daily is `com.usefulbot.*` minus everything under `dev.`, dev is
 * `com.usefulbot.dev.*`. Every read, write and delete goes through here, so a
 * stack can never touch the other's items. A UB_KEYCHAIN_PREFIX that is not the
 * stack's own value throws.
 */
function assertService(service: string): string {
  if (!keychainServiceAllowed(service)) throw new Error("keychain_service");
  return service;
}

function macosDriver(): KeychainDriver {
  return {
    get(service) {
      const result = spawnSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", service, "-a", ACCOUNT, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      if (result.status !== 0) return null;
      const value = (result.stdout ?? "").replace(/\n$/, "");
      return value ? value : null;
    },
    set(service, value) {
      // Stored values are base64url (see keychainSet), so they are safe as a
      // single -w token in command mode and never sit on argv.
      const input = Buffer.from(
        `add-generic-password -U -s ${service} -a ${ACCOUNT} -w ${value}\n`,
        "utf8",
      );
      const result = spawnSync("/usr/bin/security", ["-i"], {
        input,
        stdio: ["pipe", "ignore", "ignore"],
      });
      input.fill(0);
      if (result.status !== 0) throw new Error("keychain_write");
    },
    del(service) {
      spawnSync(
        "/usr/bin/security",
        ["delete-generic-password", "-s", service, "-a", ACCOUNT],
        { stdio: "ignore" },
      );
    },
  };
}

function active(): KeychainDriver {
  return driver ?? macosDriver();
}

export function keychainGet(service: string): string | null {
  const packed = active().get(assertService(service));
  if (!packed) return null;
  try {
    const value = Buffer.from(packed, "base64url").toString("utf8");
    return value || null;
  } catch {
    return null;
  }
}

export function keychainSet(service: string, value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) {
    throw new Error("keychain_value");
  }
  active().set(assertService(service), Buffer.from(value, "utf8").toString("base64url"));
}

export function keychainDel(service: string): void {
  active().del(assertService(service));
}

export function connectionSecretService(id: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("keychain_service");
  return keychainName(`connection.${id}`);
}
