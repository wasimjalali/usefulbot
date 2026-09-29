import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionOwners } from "../agent/lib/session-owners.ts";

test("first principal owns the session across a new store instance", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-own-"));
  const path = join(dir, "policy.sqlite");
  const first = new SessionOwners(path);
  assert.equal(first.claim("ses_a", "jwt-hmac:useful-bot:desktop-a"), "ok");
  const second = new SessionOwners(path);
  assert.equal(second.claim("ses_a", "jwt-hmac:useful-bot:desktop-b"), "forbidden");
  assert.equal(second.claim("ses_a", "jwt-hmac:useful-bot:desktop-a"), "ok");
});
