/**
 * What a tool weighs on the wire, measured rather than estimated.
 *
 * The router refuses a request whose tool array is bigger than
 * `MAX_TOOL_SCHEMA_BYTES` with a non-retryable error. A budget that charges a
 * flat rate per tool is not a defence against that: a tool picked from a
 * server can carry kilobytes of schema.
 *
 * So tools are weighed the way the router weighs them:
 * `Buffer.byteLength(JSON.stringify(tool))`, in UTF-8, including the function
 * envelope. A tool this app registers itself is weighed exactly, by asking
 * zod to emit what it will send.
 */

function utf8(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonBytes(value: unknown): number {
  if (value === undefined || value === null) return 4;
  try {
    return utf8(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/**
 * One tool's wire size from the three things that make it up. `schemaBytes`
 * is the argument schema's own JSON, which the caller measures or remembers.
 */
export function toolWireBytes(name: string, description: string, schemaBytes: number): number {
  // Measured as the router sees it: JSON-encoded, so every quote, backslash
  // and newline in a server's text costs what it costs once escaped, not
  // what it costs raw.
  const envelope = JSON.stringify({ type: "function", function: { name, description, parameters: {} } });
  return utf8(envelope) - 2 + schemaBytes;
}

export function schemaBytesOf(schema: Record<string, unknown> | null): number {
  return schema ? jsonBytes(schema) : 2;
}
