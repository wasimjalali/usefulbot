import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { loadRuntimeConfig, type CredentialDigest } from "../../shared/runtime.ts";
import { CALLER_LIMITS } from "../../shared/policy.ts";
import { RouterError } from "./errors.ts";
import type { Alias, Profile } from "../../shared/contracts.ts";

export interface AuthedCaller {
  callerId: string;
  profile: Profile | "ops";
  aliases: readonly string[];
  search: boolean;
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function equalDigest(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class AuthTable {
  private readonly credentials: CredentialDigest[];

  constructor(credentials: CredentialDigest[]) {
    this.credentials = credentials;
  }

  static fromConfigPath(path: string): AuthTable {
    const cfg = loadRuntimeConfig(path);
    return new AuthTable(cfg.credentials);
  }

  authenticate(header: string | null, now: Date = new Date()): AuthedCaller {
    if (!header || !header.startsWith("Bearer ")) {
      throw new RouterError({
        status: 401,
        type: "authentication_error",
        code: "unauthorized",
        message: "unauthorized",
      });
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      throw new RouterError({
        status: 401,
        type: "authentication_error",
        code: "unauthorized",
        message: "unauthorized",
      });
    }
    const presented = digest(token);
    let matched: CredentialDigest | null = null;
    for (const cred of this.credentials) {
      if (cred.kind !== "router") continue;
      const stored = Buffer.from(cred.sha256, "hex");
      if (stored.length !== 32) continue;
      if (equalDigest(presented, stored)) {
        matched = cred;
      }
    }
    if (!matched) {
      throw new RouterError({
        status: 401,
        type: "authentication_error",
        code: "unauthorized",
        message: "unauthorized",
      });
    }
    if (matched.revokedAt) {
      throw new RouterError({
        status: 401,
        type: "authentication_error",
        code: "unauthorized",
        message: "unauthorized",
      });
    }
    const expiresAt = Date.parse(matched.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      throw new RouterError({
        status: 401,
        type: "authentication_error",
        code: "unauthorized",
        message: "unauthorized",
      });
    }
    const limits = CALLER_LIMITS[matched.profile];
    return {
      callerId: matched.callerId,
      profile: matched.profile,
      aliases: limits.aliases,
      search: limits.search,
    };
  }

  assertAlias(caller: AuthedCaller, alias: string): Alias {
    if (!caller.aliases.includes(alias)) {
      throw new RouterError({
        status: 403,
        type: "permission_error",
        code: "alias_forbidden",
        message: "alias_forbidden",
      });
    }
    return alias as Alias;
  }
}

export function newRequestId(): string {
  return randomUUID();
}
