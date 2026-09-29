import { z } from "zod";

/**
 * A JSON Schema to a zod schema, for the subset MCP servers actually send.
 *
 * eve hands a tool's `inputSchema` to the model as the argument contract, so
 * a wrapper around someone else's tool has to present the server's own schema
 * rather than an opaque object. Anything outside the subset falls back to a
 * passthrough object with the raw schema written into the description, which
 * keeps the call possible instead of refusing it: the server validates the
 * arguments either way, and an unusable tool is worse than a loose one.
 *
 * Covered: object with properties and required, string (with enum, format
 * left alone), number, integer, boolean, array with items, null, const, a
 * union of types, anyOf/oneOf, and a nullable member in either.
 */

const MAX_DEPTH = 8;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * A server's own prose about a field does not travel with the converted
 * schema. The tool's description is fenced as untrusted; `parameters` is not,
 * and there is nowhere inside a JSON Schema to fence a string. A passthrough
 * tool still carries the whole raw schema, descriptions and all, inside the
 * fence, so nothing is lost where it can be quoted.
 */
function described(schema: z.ZodTypeAny, _node: Record<string, unknown>): z.ZodTypeAny {
  return schema;
}

function enumSchema(values: unknown[]): z.ZodTypeAny | null {
  const strings = values.filter((item): item is string => typeof item === "string");
  if (strings.length !== values.length || strings.length === 0) return null;
  // A single-value enum is still an enum, and z.enum needs a non-empty tuple.
  return z.enum(strings as [string, ...string[]]);
}

function primitive(type: string): z.ZodTypeAny | null {
  if (type === "string") return z.string();
  if (type === "number") return z.number();
  if (type === "integer") return z.number().int();
  if (type === "boolean") return z.boolean();
  if (type === "null") return z.null();
  return null;
}

function convert(node: unknown, depth: number): z.ZodTypeAny | null {
  if (depth > MAX_DEPTH) return null;
  const rec = asRecord(node);
  if (!rec) return null;

  if ("const" in rec) {
    const value = rec.const;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return described(z.literal(value), rec);
    }
    return null;
  }

  const branches = Array.isArray(rec.anyOf) ? rec.anyOf : Array.isArray(rec.oneOf) ? rec.oneOf : null;
  if (branches) {
    const parts = branches.map((branch) => convert(branch, depth + 1));
    if (parts.some((part) => part === null) || parts.length < 2) return null;
    const list = parts as z.ZodTypeAny[];
    return described(z.union([list[0], list[1], ...list.slice(2)]), rec);
  }

  // Read before the plain enum below: `{type: ["string","null"], enum: [...]}`
  // is a nullable enum, and taking the enum on its own dropped the null the
  // server accepts.
  if (Array.isArray(rec.type)) {
    const names = rec.type.filter((item): item is string => typeof item === "string");
    if (names.length !== rec.type.length || names.length === 0) return null;
    const nullable = names.includes("null");
    const rest = names.filter((name) => name !== "null");
    if (rest.length === 0) return described(z.null(), rec);
    const parts = rest.map((name) => convert({ ...rec, type: name }, depth + 1));
    if (parts.some((part) => part === null)) return null;
    const list = parts as z.ZodTypeAny[];
    const built = list.length === 1 ? list[0] : z.union([list[0], list[1], ...list.slice(2)]);
    return described(nullable ? built.nullable() : built, rec);
  }

  if (Array.isArray(rec.enum)) {
    const built = enumSchema(rec.enum);
    return built ? described(built, rec) : null;
  }

  const type = typeof rec.type === "string" ? rec.type : null;
  if (type === "object" || (!type && asRecord(rec.properties))) {
    const properties = asRecord(rec.properties) ?? {};
    const required = new Set(
      (Array.isArray(rec.required) ? rec.required : []).filter((item): item is string => typeof item === "string"),
    );
    // Null prototype: the keys are a server's to choose, and `shape.__proto__ = …`
    // on a plain object sets the prototype instead of a property.
    const shape: Record<string, z.ZodTypeAny> = Object.create(null) as Record<string, z.ZodTypeAny>;
    for (const [key, value] of Object.entries(properties)) {
      const built = convert(value, depth + 1);
      if (!built) return null;
      shape[key] = required.has(key) ? built : built.optional();
    }
    // No properties at all is a free-form object, not an empty one.
    if (Object.keys(shape).length === 0) return described(z.record(z.string(), z.unknown()), rec);
    // Passthrough, not strip: the server is the only validator here, and an
    // argument silently dropped on the way out is worse than one the server
    // refuses. The same reason the constraints below (`minimum`, `pattern`,
    // `format`) are left to it rather than half-enforced here.
    return described(z.object(shape).passthrough(), rec);
  }

  if (type === "array") {
    const items = convert(rec.items, depth + 1);
    if (!items) return null;
    return described(z.array(items), rec);
  }

  if (type) {
    const built = primitive(type);
    return built ? described(built, rec) : null;
  }

  return null;
}

export type ToolInputSchema = {
  schema: z.ZodTypeAny;
  /** True when the schema could not be converted and the raw one is the contract. */
  passthrough: boolean;
};

/**
 * The zod schema a mounted tool presents, and whether it is the server's own
 * shape or the passthrough fallback. The fallback carries the raw schema in
 * its description so the model still knows what the server expects.
 */
export function toolInputSchema(raw: Record<string, unknown> | null): ToolInputSchema {
  const built = raw ? convert(raw, 0) : null;
  if (built) {
    // eve calls tools with an object; a schema that is not one cannot be an
    // argument list whatever it validates.
    if (built instanceof z.ZodObject || built instanceof z.ZodRecord) {
      return { schema: built, passthrough: false };
    }
  }
  return { schema: z.record(z.string(), z.unknown()), passthrough: true };
}

/** What to append to a passthrough tool's description, or "" when there is nothing to say. */
export function rawSchemaHint(raw: Record<string, unknown> | null): string {
  if (!raw) return "";
  let text: string;
  try {
    text = JSON.stringify(raw);
  } catch {
    return "";
  }
  if (text.length > 2000) return "";
  return `\nArguments (JSON Schema): ${text}`;
}

/**
 * What this tool's `parameters` weigh on the wire, measured by asking zod to
 * emit them. The server's own JSON is not that number: zod re-emits, adding
 * a `$schema` key, an `additionalProperties` per object and an `anyOf` for
 * every union, which came to about twice the raw bytes on an ordinary
 * schema. A passthrough tool carries the raw schema in its description
 * instead, so that is charged in its place.
 */
export function mountedSchemaBytes(raw: Record<string, unknown> | null): number {
  const { schema, passthrough } = toolInputSchema(raw);
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(z.toJSONSchema(schema, { io: "input" })), "utf8");
  } catch {
    // An emission this side cannot take is one it cannot weigh either; the
    // raw schema doubled is the nearest honest figure.
    bytes = raw ? Buffer.byteLength(JSON.stringify(raw), "utf8") * 2 : 64;
  }
  return bytes + (passthrough ? Buffer.byteLength(rawSchemaHint(raw), "utf8") : 0);
}
