/**
 * Request-boundary guards shared by the JSON API routes: bounded body reads,
 * JSON content-type enforcement, stable error codes, and a small in-process
 * rate limiter for the expensive endpoints. Framework-free on purpose so the
 * rules can be unit-tested without booting Next.
 */

export const JSON_BODY_MAX = 256 * 1024;
/**
 * A turn can carry up to five images as data URLs (~1.4 MB each encoded), so
 * the eve proxy takes the same cap as the router's completion route.
 */
export const EVE_BODY_MAX = 8 * 1024 * 1024;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Turn a guard error into its response; null when it is not a guard error. */
export function apiError(err: unknown): Response | null {
  if (err instanceof ApiError) {
    return Response.json({ ok: false, error: err.code }, { status: err.status });
  }
  return null;
}

/**
 * Map an internal error to a stable code at the API boundary. Short snake_case
 * codes pass through; anything free-form, such as an fs error carrying an
 * absolute path or a JSON.parse position, is replaced with the fallback.
 */
const CODE = /^[a-z][a-z0-9_.:-]{0,80}$/;

export function errorCode(err: unknown, fallback = "invalid"): string {
  const message = err instanceof Error ? err.message : "";
  return CODE.test(message) ? message : fallback;
}

/** Read a request body with a hard byte cap, before anything is parsed. */
export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, "payload_too_large");
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // The stream is consumed rather than cancelled: this runtime's body
      // pump keeps enqueueing after a cancel and the throw inside it escapes
      // as an unhandled rejection. The drain is time-bounded, so a stalled
      // peer cannot pin the route; past the budget we stop reading and the
      // socket's own backpressure holds whatever remains.
      const deadline = Date.now() + 5_000;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        const next = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), left)),
        ]);
        if (next === null || next.done) break;
      }
      throw new ApiError(413, "payload_too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Parse a JSON body under the guard. Rejects non-JSON content types with 415. */
export async function readJson(request: Request, maxBytes = JSON_BODY_MAX): Promise<unknown> {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    throw new ApiError(415, "unsupported_media_type");
  }
  const bytes = await readBody(request, maxBytes);
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

const MULTIPART = "multipart/form-data";

/**
 * Parse a multipart body under the guard. The request is streamed into a
 * bounded buffer first, so a chunked upload with no content-length cannot make
 * `formData()` buffer an unbounded body before the per-file check runs.
 */
export async function readFormData(request: Request, maxBytes: number): Promise<FormData> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith(MULTIPART)) {
    throw new ApiError(415, "unsupported_media_type");
  }
  const bytes = await readBody(request, maxBytes);
  const rebuilt = new Request(request.url, {
    method: "POST",
    headers: { "content-type": type },
    // readBody allocates an exact-length Uint8Array, so its backing buffer is
    // the payload; the cast narrows ArrayBufferLike to the BodyInit type.
    body: bytes.buffer as ArrayBuffer,
  });
  try {
    return await rebuilt.formData();
  } catch {
    throw new ApiError(400, "invalid_multipart");
  }
}

type Bucket = { tokens: number; updated: number };
const buckets = new Map<string, Bucket>();
const BUCKET_IDLE_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60_000;
let lastSweep = 0;

function sweepIdle(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updated > BUCKET_IDLE_MS) buckets.delete(key);
  }
}

/**
 * Token bucket keyed by an opaque caller identity. Returns true when the caller
 * is over budget and the request should be answered 429. In-process only, which
 * is enough for the single loopback web server.
 *
 * `now` is injectable for tests; callers use the default. Idle buckets are
 * swept so a rotating key (for example a per-login cookie hash) cannot grow the
 * map without bound.
 */
export function rateLimited(key: string, perMinute: number, burst = perMinute, now = Date.now()): boolean {
  sweepIdle(now);
  const bucket = buckets.get(key);
  const capacity = Math.max(1, Math.floor(burst));
  if (!bucket) {
    buckets.set(key, { tokens: capacity - 1, updated: now });
    return false;
  }
  const refill = ((now - bucket.updated) * perMinute) / 60_000;
  bucket.tokens = Math.min(capacity, bucket.tokens + refill);
  bucket.updated = now;
  if (bucket.tokens < 1) return true;
  bucket.tokens -= 1;
  return false;
}

/** Number of live buckets; exported for the eviction test. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}
