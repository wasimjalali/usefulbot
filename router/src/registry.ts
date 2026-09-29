import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RouterError } from "./errors.ts";
import type { Alias } from "../../shared/contracts.ts";

export interface RegistryEntry {
  alias: Alias;
  upstream: string;
  upstreamModelId: string;
  modelContextWindowTokens: number;
  maxOutputTokens: number;
  reasoningEffort: "low" | "high";
  evidence: {
    sourceUrls: string[];
    checkedAt: string;
    liveGate: string;
    liveVerified: boolean;
    packageLockHash: string | null;
  };
}

interface RegistryFile {
  schemaVersion: number;
  entries: RegistryEntry[];
}

const ALIASES = new Set(["workhorse", "reviewer"]);

function invalidRegistry(): RouterError {
  return new RouterError({
    status: 503,
    type: "internal_error",
    code: "configuration_unverified",
    message: "registry invalid",
  });
}

function validEntry(entry: RegistryEntry): boolean {
  return Boolean(
    entry
    && typeof entry === "object"
    && ALIASES.has(entry.alias)
    && typeof entry.upstream === "string"
    && entry.upstream.length > 0
    && typeof entry.upstreamModelId === "string"
    && entry.upstreamModelId.length > 0
    && Number.isInteger(entry.modelContextWindowTokens)
    && entry.modelContextWindowTokens > 0
    && Number.isInteger(entry.maxOutputTokens)
    && entry.maxOutputTokens > 0
    && (entry.reasoningEffort === "low" || entry.reasoningEffort === "high")
    && entry.evidence
    && typeof entry.evidence === "object"
    && Array.isArray(entry.evidence.sourceUrls)
    && entry.evidence.sourceUrls.length > 0
    && typeof entry.evidence.checkedAt === "string"
    && entry.evidence.liveGate === "S1"
    && entry.evidence.liveVerified === true
    && typeof entry.evidence.packageLockHash === "string"
    && entry.evidence.packageLockHash.length > 0,
  );
}

export function loadRegistry(lockPath: string): RegistryEntry[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const registryPath = join(here, "../../shared/registry.json");
  const file = JSON.parse(readFileSync(registryPath, "utf8")) as RegistryFile;
  if (file.schemaVersion !== 1 || !Array.isArray(file.entries) || file.entries.length === 0) {
    throw invalidRegistry();
  }
  const seen = new Set<string>();
  for (const entry of file.entries) {
    if (!validEntry(entry) || seen.has(entry.alias)) {
      throw invalidRegistry();
    }
    seen.add(entry.alias);
  }
  const lockHash = createHash("sha256").update(readFileSync(lockPath)).digest("hex");
  for (const entry of file.entries) {
    if (entry.evidence.packageLockHash !== lockHash) {
      throw new RouterError({
        status: 503,
        type: "internal_error",
        code: "configuration_unverified",
        message: "package-lock hash mismatch",
      });
    }
  }
  return file.entries;
}

export function entryFor(entries: RegistryEntry[], alias: string): RegistryEntry {
  const found = entries.find((item) => item.alias === alias);
  if (!found) {
    throw new RouterError({
      status: 400,
      type: "invalid_request_error",
      code: "unknown_alias",
      message: "unknown_alias",
    });
  }
  return found;
}
