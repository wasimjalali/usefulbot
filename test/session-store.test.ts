import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dropBrowserSession,
  getBrowserSession,
  putBrowserSession,
} from "../shared/web-sessions.ts";

test("browser sessions persist across store instances", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-sess-")), "web-sessions.json");
  putBrowserSession("tok-a", {
    callerId: "desktop",
    profile: "desktop",
    csrf: "csrf-a",
    expiresAt: Date.now() + 60_000,
    credentialId: null,
  }, path);
  const found = getBrowserSession("tok-a", path);
  assert.equal(found?.profile, "desktop");
  assert.equal(getBrowserSession("tok-b", path), null);
  dropBrowserSession("tok-a", path);
  assert.equal(getBrowserSession("tok-a", path), null);
});

test("expired browser sessions are not returned", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-sess-")), "web-sessions.json");
  putBrowserSession("tok-old", {
    callerId: "desktop",
    profile: "desktop",
    csrf: "csrf-old",
    expiresAt: Date.now() - 1,
    credentialId: null,
  }, path);
  assert.equal(getBrowserSession("tok-old", path), null);
});
