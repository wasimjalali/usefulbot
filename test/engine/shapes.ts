import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Compares what the engine produced with the protocol fixtures by shape: the
 * keys of each object and the type of each value, never the values. The
 * fixtures' ids, times and counters are synthetic, so they cannot be compared;
 * their field names and types are the contract the Swift client decodes.
 */

const FIXTURES = fileURLToPath(new URL("../fixtures/chat-protocol/", import.meta.url));

export function fixtureLines(name: string): Record<string, unknown>[] {
  return readFileSync(`${FIXTURES}${name}`, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function fixtureJson<T>(name: string): T {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8")) as T;
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** `{a:string,b:{c:number},d:array<id:string,label:string>}`, keys sorted. */
export function shape(value: unknown): string {
  if (Array.isArray(value)) {
    const union = new Map<string, Set<string>>();
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        for (const [key, inner] of Object.entries(item as Record<string, unknown>)) {
          const seen = union.get(key) ?? new Set<string>();
          seen.add(shape(inner));
          union.set(key, seen);
        }
      }
    }
    if (union.size === 0) return value.length === 0 ? "array" : `array<${[...new Set(value.map(kindOf))].sort().join("|")}>`;
    return `array<${[...union.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, seen]) => `${key}:${[...seen].sort().join("|")}`).join(",")}>`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      // A row's turnId is null when it was filed outside a turn and a string inside one: not part of the shape.
      .filter(([key]) => key !== "turnId")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, inner]) => `${key}:${shape(inner)}`)
      .join(",")}}`;
  }
  return kindOf(value);
}

/** The key a protocol event or row is grouped under: its type, plus the kind of a `row` event. */
export function groupOf(event: Record<string, unknown>): string {
  if (event.type === "row") {
    const row = event.row as Record<string, unknown>;
    return `row:${String(row.kind)}${row.kind === "note" ? `:${String(row.source)}` : ""}`;
  }
  return String(event.type);
}

function shapesByGroup(events: Record<string, unknown>[]): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const event of events) {
    // The envelope fields are checked everywhere; compare the rest.
    const { seq: _seq, epoch: _epoch, at: _at, chatId: _chatId, turnId: _turnId, ...body } = event;
    const group = groupOf(event);
    const seen = groups.get(group) ?? new Set<string>();
    seen.add(shape(body));
    groups.set(group, seen);
  }
  return groups;
}

export function assertEnvelope(events: Record<string, unknown>[]): void {
  for (const event of events) {
    assert.equal(typeof event.seq, "number", `seq on ${String(event.type)}`);
    assert.equal(typeof event.epoch, "string");
    assert.match(String(event.at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(typeof event.chatId, "string");
  }
}

/**
 * Every shape the fixture has was produced, and every shape produced is one the
 * fixture has. `missing` and `extra` list groups a scenario cannot cover (a
 * different file's scenario does).
 */
export function assertShapes(
  produced: Record<string, unknown>[],
  fixture: Record<string, unknown>[],
  options: { missing?: string[]; extra?: string[] } = {},
): void {
  const made = shapesByGroup(produced);
  const wanted = shapesByGroup(fixture);
  for (const [group, shapes] of wanted) {
    if (options.missing?.includes(group)) continue;
    const got = made.get(group);
    assert.ok(got, `the engine never produced a ${group}`);
    for (const wantedShape of shapes) assert.ok(got.has(wantedShape), `${group}: fixture has ${wantedShape}\n   engine produced ${[...got].join("\n                   ")}`);
  }
  for (const [group, shapes] of made) {
    if (options.extra?.includes(group)) continue;
    const known = wanted.get(group);
    assert.ok(known, `the engine produced a ${group} the fixture does not have`);
    for (const madeShape of shapes) assert.ok(known.has(madeShape), `${group}: engine produced ${madeShape}\n   fixture has ${[...known].join("\n               ")}`);
  }
}
