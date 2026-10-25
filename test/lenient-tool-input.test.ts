import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { validateToolArguments } from "@earendil-works/pi-ai";
import memory from "../agent/tools/memory.ts";
import writeFile from "../agent/tools/write_file.ts";

// GLM 5.3 Flash sent "expectedRevision":"null" and "expiresAt":"null" as strings
// (and once left expiresAt out), and every memory_upsert call failed validation.
// The same inputs now reach the one `memory` tool, and must get through both
// layers: our zod schema, and Pi's JSON-Schema validator after `prepareArguments`.

type Parsed = Record<string, unknown>;
const parse = (tool: { inputSchema: z.ZodType }, value: unknown) => tool.inputSchema.safeParse(value) as
  { success: boolean; data?: Parsed };

const note = { action: "save", title: "t", tags: [], body: "b" };

/** What Pi does with a call: prepareArguments, then validation against the declared schema. */
function throughPi(tool: { name: string; description: string; parameters: Record<string, unknown>; prepareArguments: (raw: unknown) => unknown }, raw: unknown) {
  const prepared = tool.prepareArguments(raw);
  return validateToolArguments(
    { name: tool.name, description: tool.description, parameters: tool.parameters as never },
    { type: "toolCall", id: "call-1", name: tool.name, arguments: prepared as never },
  ) as Parsed;
}

test("memory save accepts the exact inputs the model sent", () => {
  const sent = parse(memory, { ...note, expectedRevision: "null", expiresAt: "null" });
  assert.equal(sent.success, true);
  assert.equal(sent.data?.expectedRevision, null);
  assert.equal(sent.data?.expiresAt, null);
  const omitted = parse(memory, { ...note, expectedRevision: "null" });
  assert.equal(omitted.success, true);
  assert.equal(omitted.data?.expiresAt, null);
});

test("memory save reads null, empty, missing and numeric-string revisions", () => {
  for (const value of [null, undefined, "", "null", "NULL"]) {
    const out = parse(memory, { ...note, expectedRevision: value, expiresAt: value });
    assert.equal(out.success, true, String(value));
    assert.equal(out.data?.expectedRevision, null);
    assert.equal(out.data?.expiresAt, null);
  }
  assert.equal(parse(memory, { ...note, expectedRevision: "3" }).data?.expectedRevision, 3);
  assert.equal(parse(memory, { ...note, expectedRevision: 3 }).data?.expectedRevision, 3);
});

test("memory still rejects a bad revision, a bad date and an unknown action", () => {
  assert.equal(parse(memory, { ...note, expectedRevision: "abc" }).success, false);
  assert.equal(parse(memory, { ...note, expectedRevision: {} }).success, false);
  assert.equal(parse(memory, { ...note, expiresAt: "tomorrow" }).success, false);
  assert.equal(parse(memory, { ...note, action: "upsert" }).success, false);
  assert.equal(parse(memory, { action: "delete", id: "a", expectedRevision: "1.5" }).success, false);
  const good = parse(memory, { ...note, expiresAt: "2026-12-01T10:00:00Z" });
  assert.equal(good.success, true);
  assert.equal(good.data?.expiresAt, "2026-12-01T10:00:00Z");
});

test("memory delete takes a numeric string revision and rejects the rest", () => {
  assert.equal(parse(memory, { action: "delete", id: "a", expectedRevision: "2" }).data?.expectedRevision, 2);
  assert.equal(parse(memory, { action: "delete", id: "a", expectedRevision: 2 }).data?.expectedRevision, 2);
  for (const bad of ["1.5", 1.5, "0x10", "1e2", "+3"]) {
    assert.equal(parse(memory, { action: "delete", id: "a", expectedRevision: bad }).success, false, String(bad));
  }
  assert.equal(parse(memory, { action: "delete", id: "a", expectedRevision: " -2 " }).data?.expectedRevision, -2);
});

test("write_file reads a missing, empty or 'null' expectedSha256 as null", () => {
  for (const value of [null, undefined, "", "null"]) {
    const out = parse(writeFile, { path: "a.txt", content: "x", expectedSha256: value });
    assert.equal(out.success, true, String(value));
    assert.equal(out.data?.expectedSha256, null);
  }
  const hash = "a".repeat(64);
  assert.equal(parse(writeFile, { path: "a.txt", content: "x", expectedSha256: hash }).data?.expectedSha256, hash);
});

test("only plain integer strings count as numbers, and whitespace means none", () => {
  for (const bad of ["0x10", "1e2"]) {
    assert.equal(parse(memory, { ...note, expectedRevision: bad }).success, false, bad);
  }
  const blank = parse(memory, { ...note, expectedRevision: "  ", expiresAt: "   " });
  assert.equal(blank.data?.expectedRevision, null);
  assert.equal(blank.data?.expiresAt, null);
});

test("the JSON schema the model sees keeps the types, optionality and a description", () => {
  const props = memory.parameters.properties as Record<string, { type?: string[]; description?: string }>;
  assert.deepEqual(props.expectedRevision?.type, ["number", "string", "null"]);
  assert.deepEqual(props.expiresAt?.type, ["string", "null"]);
  const write = writeFile.parameters.properties as Record<string, { type?: string[]; description?: string }>;
  assert.deepEqual(write.expectedSha256?.type, ["string", "null"]);
  assert.ok(props.expectedRevision?.description, "expectedRevision lost its description");
  assert.ok(props.expiresAt?.description, "expiresAt lost its description");
  assert.ok(write.expectedSha256?.description, "expectedSha256 lost its description");
  const required = memory.parameters.required as string[];
  assert.deepEqual(required, ["action"]);
  assert.ok(!(writeFile.parameters.required as string[]).includes("expectedSha256"));
});

// Contract test 9 (SPEC 14): the same inputs through Pi's own validator.

test("Pi's validator takes the lenient inputs once prepareArguments has run", () => {
  for (const value of [null, undefined, "", "null", "NULL", "  "]) {
    const out = throughPi(memory, { ...note, expectedRevision: value, expiresAt: value });
    assert.equal(out.action, "save");
    assert.equal(out.expectedRevision ?? null, null, String(value));
    assert.equal(out.expiresAt ?? null, null, String(value));
  }
  assert.equal(throughPi(memory, { ...note, expectedRevision: "3" }).expectedRevision, 3);
  assert.equal(throughPi(memory, { action: "delete", id: "a", expectedRevision: "2" }).expectedRevision, 2);
  for (const value of [null, undefined, "", "null"]) {
    const out = throughPi(writeFile, { path: "a.txt", content: "x", expectedSha256: value });
    assert.equal(out.expectedSha256 ?? null, null, String(value));
  }
});

test("Pi's validator still refuses what zod refuses", () => {
  assert.throws(() => throughPi(memory, { ...note, action: "upsert" }), /action/);
  assert.throws(() => throughPi(memory, { ...note, expectedRevision: {} }), /expectedRevision/);
  assert.throws(() => throughPi(writeFile, { content: "x" }), /path/);
});
