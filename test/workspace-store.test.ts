import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRANTS_MAX,
  parseWorkspacePermission,
  parseWorkspaceStore,
  readSessionGrant,
  readWorkspaceStore,
  removeProject,
  removeSessionGrant,
  upsertProject,
  upsertSessionGrant,
} from "../shared/workspace-store.ts";

function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "ub-workspace-"));
  return join(dir, "workspace.json");
}

test("permission parsing accepts the three modes, and the old name for Auto", () => {
  assert.equal(parseWorkspacePermission("read_only"), "read_only");
  assert.equal(parseWorkspacePermission("auto"), "auto");
  // The store a Guard-era build wrote still reads as the same posture.
  assert.equal(parseWorkspacePermission("guard"), "auto");
  assert.equal(parseWorkspacePermission("full_access"), "full_access");
  assert.equal(parseWorkspacePermission("owner"), null);
  assert.equal(parseWorkspacePermission(undefined), null);
});

test("grant upsert round-trips and a newer write wins per session", () => {
  const path = tempStore();
  upsertSessionGrant(
    { sessionId: "s1", path: "/tmp/a", permission: "auto" },
    new Date("2026-09-14T10:00:00Z"),
    path,
  );
  upsertSessionGrant(
    { sessionId: "s1", path: "/tmp/b", permission: "full_access" },
    new Date("2026-09-14T11:00:00Z"),
    path,
  );
  upsertSessionGrant(
    { sessionId: "s2", path: "/tmp/c", permission: "read_only" },
    new Date("2026-09-14T09:00:00Z"),
    path,
  );
  const store = readWorkspaceStore(path);
  assert.equal(store.grants.length, 2);
  const s1 = store.grants.find((grant) => grant.sessionId === "s1");
  assert.equal(s1?.path, "/tmp/b");
  assert.equal(s1?.permission, "full_access");
  const grant = readSessionGrant("s1", path);
  assert.equal(grant?.permission, "full_access");
  assert.equal(readSessionGrant("missing", path), null);
  assert.equal(readSessionGrant("", path), null);
});

test("grant pruning keeps the newest window", () => {
  const path = tempStore();
  for (let i = 0; i < GRANTS_MAX + 10; i++) {
    upsertSessionGrant(
      { sessionId: `s${i}`, path: `/tmp/${i}`, permission: "auto" },
      new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      path,
    );
  }
  const store = readWorkspaceStore(path);
  assert.equal(store.grants.length, GRANTS_MAX);
  // Oldest sessions fall out; the newest stays.
  assert.equal(store.grants.some((grant) => grant.sessionId === "s0"), false);
  assert.equal(store.grants.some((grant) => grant.sessionId === `s${GRANTS_MAX + 9}`), true);
});

test("projects dedupe by path, and remove by id", () => {
  const path = tempStore();
  upsertProject({ path: "/tmp/proj", name: "proj" }, new Date("2026-09-14T10:00:00Z"), path);
  upsertProject({ path: "/tmp/proj", name: "proj renamed" }, new Date("2026-09-14T11:00:00Z"), path);
  upsertProject({ path: "/tmp/other", name: "other" }, new Date("2026-09-14T11:00:00Z"), path);
  const store = readWorkspaceStore(path);
  assert.equal(store.projects.length, 2);
  const proj = store.projects.find((item) => item.path === "/tmp/proj");
  assert.equal(proj?.name, "proj renamed");
  removeProject(proj!.id, path);
  assert.equal(readWorkspaceStore(path).projects.some((item) => item.path === "/tmp/proj"), false);
});

test("a corrupt store reads as empty instead of blocking a turn", () => {
  const path = tempStore();
  writeFileSync(path, "{not json", { encoding: "utf8" });
  assert.deepEqual(readWorkspaceStore(path), { schemaVersion: 1, grants: [], projects: [] });
});

test("parse tolerates unknown and malformed records", () => {
  const parsed = parseWorkspaceStore({
    schemaVersion: 1,
    grants: [
      { sessionId: "ok", path: "/tmp/x", permission: "auto", extra: "kept" },
      { sessionId: "", path: "/tmp/y", permission: "auto" },
      { sessionId: "badpath", path: "not-absolute", permission: "auto" },
      { sessionId: "badmode", path: "/tmp/z", permission: "admin" },
      "junk",
    ],
    projects: [{ id: "p", path: "/tmp/p", name: "p", extra: true }, null],
    someday: true,
  });
  assert.equal(parsed.grants.length, 1);
  assert.equal(parsed.projects.length, 1);
  assert.equal(parsed.schemaVersion, 1);
});

test("detaching revokes the grant, not just the bot field", () => {
  const path = tempStore();
  upsertSessionGrant(
    { sessionId: "s1", path: "/tmp/a", permission: "full_access" },
    new Date(),
    path,
  );
  assert.ok(readSessionGrant("s1", path));
  removeSessionGrant("s1", path);
  assert.equal(readSessionGrant("s1", path), null);
  // Revoking an unknown session is a no-op, not an error.
  removeSessionGrant("never-existed", path);
});

test("duplicate rows keep the newest, not first-in-file", () => {
  const path = tempStore();
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      // Older record first in file order; the newer one must win.
      grants: [
        { sessionId: "s1", path: "/tmp/old", permission: "read_only", updatedAt: "2026-09-14T10:00:00Z" },
        { sessionId: "s1", path: "/tmp/new", permission: "full_access", updatedAt: "2026-09-14T11:00:00Z" },
      ],
      projects: [
        { id: "p1", path: "/tmp/p", name: "old name", lastUsedAt: "2026-09-14T10:00:00Z" },
        { id: "p1", path: "/tmp/p", name: "new name", lastUsedAt: "2026-09-14T11:00:00Z" },
      ],
    }),
    "utf8",
  );
  const store = readWorkspaceStore(path);
  assert.equal(store.grants.length, 1);
  assert.equal(store.grants[0].path, "/tmp/new");
  assert.equal(store.projects[0].name, "new name");
});

test("a corrupt store is backed up before a write starts from the seed", () => {
  const path = tempStore();
  writeFileSync(path, "{corrupt", { encoding: "utf8" });
  upsertSessionGrant(
    { sessionId: "s1", path: "/tmp/a", permission: "auto" },
    new Date(),
    path,
  );
  // The corrupt bytes survive as evidence beside the store.
  const dir = path.slice(0, path.lastIndexOf("/"));
  const backup = readdirSync(dir).find((name: string) => name.includes(".invalid."));
  assert.ok(backup, "corrupt store must be backed up, not clobbered");
  assert.equal(readWorkspaceStore(path).grants.length, 1);
});

test("a grant on the filesystem root is refused", () => {
  const path = tempStore();
  assert.throws(
    () => upsertSessionGrant(
      { sessionId: "s1", path: "/", permission: "auto" },
      new Date(),
      path,
    ),
    /workspace_path_invalid/,
  );
  assert.equal(readSessionGrant("s1", path), null);
});

test("a grant on a credential folder is refused at the store, not only the route", () => {
  const path = tempStore();
  for (const bad of ["/Users/someone/Library/Keychains", "/Users/someone/.ssh", "/Users/someone/secrets"]) {
    assert.throws(
      () => upsertSessionGrant(
        { sessionId: "s1", path: bad, permission: "read_only" },
        new Date(),
        path,
      ),
      /workspace_path_invalid/,
      bad,
    );
  }
});

test("an unknown permission is refused at upsert instead of dropping on read", () => {
  const path = tempStore();
  assert.throws(
    () => upsertSessionGrant(
      // A JS caller can pass anything the type forbids; the store is the guard.
      { sessionId: "s1", path: "/tmp/a", permission: "admin" as never },
      new Date(),
      path,
    ),
    /workspace_permission_invalid/,
  );
});

test("a hand-edited grant on the filesystem root does not read back", () => {
  const path = tempStore();
  const store = parseWorkspaceStore({
    schemaVersion: 1,
    grants: [
      { sessionId: "s1", path: "/", permission: "full_access", updatedAt: new Date().toISOString() },
      { sessionId: "s2", path: "/tmp/ok", permission: "auto", updatedAt: new Date().toISOString() },
    ],
    projects: [],
  });
  assert.equal(store.grants.length, 1);
  assert.equal(store.grants[0].sessionId, "s2");
  assert.equal(path.length > 0, true);
});

test("a project recent on the filesystem root is refused", () => {
  const path = tempStore();
  assert.throws(
    () => upsertProject({ path: "/", name: "root" }, new Date(), path),
    /workspace_path_invalid/,
  );
});

test("the credential folders added in round 3 are refused as grant roots", () => {
  const path = tempStore();
  const refused = [
    "/Users/someone/Library/Keychains",
    "/Users/someone/.docker",
    "/Users/someone/.kube",
    "/Users/someone/.npmrc",
    "/Users/someone/.netrc",
    "/Users/someone/.pypirc",
    "/Users/someone/.authinfo",
    "/Users/someone/Library/Cookies",
  ];
  for (const bad of refused) {
    assert.throws(
      () => upsertSessionGrant(
        { sessionId: "s1", path: bad, permission: "read_only" },
        new Date(),
        path,
      ),
      /workspace_path_invalid/,
      bad,
    );
  }
  // A project that merely mentions one of these words is still grantable.
  upsertSessionGrant(
    { sessionId: "s1", path: "/Users/someone/keychain-viewer-app", permission: "auto" },
    new Date(),
    path,
  );
  assert.equal(readSessionGrant("s1", path)?.path, "/Users/someone/keychain-viewer-app");
});

test("a grant with no folder carries the permission alone and survives a round-trip", () => {
  const path = tempStore();
  upsertSessionGrant({ sessionId: "s1", path: null, permission: "read_only" }, new Date(), path);
  const grant = readSessionGrant("s1", path);
  assert.equal(grant?.path, null);
  assert.equal(grant?.permission, "read_only");
  // A folder can still be attached later, and detached back to none.
  upsertSessionGrant({ sessionId: "s1", path: "/tmp/a", permission: "auto" }, new Date(Date.now() + 1000), path);
  assert.equal(readSessionGrant("s1", path)?.path, "/tmp/a");
  upsertSessionGrant({ sessionId: "s1", path: null, permission: "auto" }, new Date(Date.now() + 2000), path);
  assert.equal(readSessionGrant("s1", path)?.path, null);
  // The root of the disk is still not a folder anyone can be granted.
  assert.throws(() => upsertSessionGrant({ sessionId: "s2", path: "/", permission: "auto" }, new Date(), path), /workspace_path_invalid/);
});
