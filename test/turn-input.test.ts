import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTurnBody, TurnBodyError } from "../shared/turn-input.ts";

const CLIENT = "c1c1c1c1-0000-4000-8000-0000000000c1";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TurnBodyError);
    return error.code;
  }
  assert.fail("expected a TurnBodyError");
}

test("the body the web relays parses again on the engine (the two run the same check)", () => {
  for (const raw of [
    { clientId: CLIENT, text: "hello", attachments: [] },
    { clientId: CLIENT, text: "", retry: true },
    { clientId: CLIENT, text: "notes", attachments: [{ name: "a.txt", mediaType: "text/plain", size: 3, text: "abc" }] },
  ]) {
    const once = parseTurnBody(JSON.stringify(raw));
    const twice = parseTurnBody(JSON.stringify(once));
    assert.deepEqual(twice, once);
  }
});

test("retry is a boolean or absent", () => {
  assert.equal(parseTurnBody({ clientId: CLIENT, text: "x", retry: false }).retry, false);
  assert.equal(parseTurnBody({ clientId: CLIENT, text: "x" }).retry, false);
  assert.equal(code(() => parseTurnBody({ clientId: CLIENT, text: "x", retry: "yes" })), "turn_invalid");
  assert.equal(code(() => parseTurnBody({ clientId: CLIENT, text: "x", retry: 1 })), "turn_invalid");
});

test("an empty owner message is refused, an empty retry is not", () => {
  assert.equal(code(() => parseTurnBody({ clientId: CLIENT, text: "  " })), "turn_empty");
  assert.equal(parseTurnBody({ clientId: CLIENT, text: "", retry: true }).retry, true);
});

test("a bad client id or body shape is refused with its code", () => {
  assert.equal(code(() => parseTurnBody({ clientId: "nope", text: "x" })), "client_id_invalid");
  assert.equal(code(() => parseTurnBody("not json")), "invalid_json");
  assert.equal(code(() => parseTurnBody([])), "turn_invalid");
});
