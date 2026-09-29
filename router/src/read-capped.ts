import { RouterError } from "./errors.ts";

/**
 * Read an upstream response body with a hard ceiling: the stream is cancelled
 * the moment it passes the limit instead of being buffered whole first.
 */
export async function readCappedBytes(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    throw new RouterError({
      status: 502,
      type: "upstream_error",
      code: "upstream_protocol_error",
      message: "upstream body too large",
    });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new RouterError({
        status: 502,
        type: "upstream_error",
        code: "upstream_protocol_error",
        message: "upstream body too large",
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function readCapped(response: Response, limit: number): Promise<string> {
  return (await readCappedBytes(response, limit)).toString("utf8");
}

/**
 * The first `limit` bytes of a body, then the rest is cancelled. For an error
 * body the router only wants to name, never relay whole.
 */
export async function readPrefix(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  // A streaming decode holds back a character the cap cut in half, where
  // toString would end the text in a replacement mark.
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit), { stream: true });
}
