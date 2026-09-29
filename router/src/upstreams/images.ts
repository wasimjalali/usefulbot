import { RouterError } from "../errors.ts";
import { upstreamLimitError } from "../retry-after.ts";
import { readCappedBytes } from "../read-capped.ts";
import {
  readProviderStore,
  resolveUpstream,
  withImagePick,
} from "../../../shared/providers.ts";
import { catalogFor } from "../../../shared/live-models.ts";
import { IMAGE_BYTES_MAX, IMAGE_MIME } from "../../../shared/images-store.ts";
import {
  assertPublicHttpsUrl,
  assertResolvedPublic,
  ConnectionUrlError,
} from "../../../shared/connection-url.ts";
import {
  authFailed,
  clearConnectionError,
  noteConnectionError,
  tokenFor,
  upstreamConfigError,
  upstreamOutOfCredit,
} from "./opencode.ts";

/**
 * OpenAI shaped POST {base}/images/generations. The modes that carry the
 * `images` flag (openai:api, xai:api, zai:api, openrouter:api) all speak it;
 * what differs is the path (OpenRouter serves /images), the size knob and
 * whether the answer is base64 or a URL to download.
 */

/** The tool asks in shapes; the provider takes the numbers it knows. */
export type ImageSize = "square" | "wide" | "tall";

/**
 * Each provider's size contract, per docs.openai.com, docs.x.ai and
 * docs.z.ai. Anything not listed sends no size and takes the model default:
 * a wrong guess is a guaranteed upstream error, a missing one is not.
 */
const SIZE_DIMENSIONS: Record<string, Record<ImageSize, string>> = {
  "dall-e-3": { square: "1024x1024", wide: "1792x1024", tall: "1024x1792" },
  "gpt-image": { square: "1024x1024", wide: "1536x1024", tall: "1024x1536" },
  zai: { square: "1280x1280", wide: "1568x1056", tall: "1056x1568" },
};

const SIZE_ASPECT: Record<ImageSize, string> = {
  square: "1:1",
  wide: "16:9",
  tall: "9:16",
};

/** The next best ratio when a model does not take the first choice (gpt-image takes 3:2, not 16:9). */
const SIZE_ASPECT_FALLBACK: Record<ImageSize, string[]> = {
  square: [],
  wide: ["3:2", "4:3"],
  tall: ["2:3", "3:4"],
};

function aspectFor(size: ImageSize, supported: string[] | undefined): string | null {
  // Unknown ratios (a cold cache) send none: the model default beats a guess
  // the upstream may refuse after the call is made.
  if (!supported) return null;
  return [SIZE_ASPECT[size], ...SIZE_ASPECT_FALLBACK[size]].find((ratio) => supported.includes(ratio)) ?? null;
}

/**
 * The generations answer can carry up to four base64 images plus framing;
 * each is capped at IMAGE_BYTES_MAX decoded, so the body cannot exceed this.
 */
const RESPONSE_MAX_BYTES = 4 * Math.ceil(IMAGE_BYTES_MAX * 4 / 3) + 1_000_000;
const IMAGE_FETCH_MS = 60_000;

/**
 * Images bill per picture, which token budgets cannot see directly, so each
 * one is charged a nominal 1500 units — roughly a mid-quality 1024px render.
 * The route reserves n * this before dispatch and reconciles to the real
 * count after, so an owner's daily cap covers image spend like chat spend.
 */
export const IMAGE_USAGE_TOKENS = 1500;

export interface NormalizedImage {
  b64: string;
  mime: string;
}

function sizeParams(providerId: string, model: string, size: ImageSize | undefined, ratios?: string[]): Record<string, unknown> {
  if (!size) return {};
  // xAI and OpenRouter take aspect_ratio instead of a pixel size (docs.x.ai
  // images generation, openrouter.ai image generation); OpenAI and Z.AI both
  // take WxH on `size`. OpenRouter lists each model's ratios, so a shape the
  // model cannot take goes to its nearest one, or to the model default.
  if (providerId === "xai") return { aspect_ratio: SIZE_ASPECT[size] };
  if (providerId === "openrouter") {
    const ratio = aspectFor(size, ratios);
    return ratio ? { aspect_ratio: ratio } : {};
  }
  const family = imageFamily(providerId, model);
  const dims = family ? SIZE_DIMENSIONS[family] : undefined;
  return dims ? { size: dims[size] } : {};
}

function imageFamily(providerId: string, model: string): string | null {
  if (providerId === "zai") return "zai";
  return Object.keys(SIZE_DIMENSIONS).find((key) => key !== "zai" && model.startsWith(key)) ?? null;
}

function upstreamProtocolError(): RouterError {
  return new RouterError({
    status: 502,
    type: "upstream_error",
    code: "upstream_protocol_error",
    message: "upstream_protocol_error",
  });
}

/**
 * Provider-returned download URLs get the full SSRF screen before any byte
 * moves: https only, no credentials, no literal IPs, no loopback, default
 * port, and the hostname must resolve to a public IPv4. The shared helpers
 * allow 127.0.0.1 for owner-typed local URLs, so assertPublicHttpsUrl (which
 * refuses it) runs first.
 */
async function imageFetchUrl(raw: string): Promise<string> {
  try {
    const href = assertPublicHttpsUrl(raw);
    if (new URL(href).port) throw new ConnectionUrlError("url_port");
    return await assertResolvedPublic(href);
  } catch {
    throw upstreamProtocolError();
  }
}

async function fetchImageBytes(rawUrl: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<{ bytes: Buffer; mime: string }> {
  // The URL came from the upstream's answer, not from the caller, but it is
  // still fetched like anything remote: screened host, no redirects followed
  // blindly, a streamed byte cap, and an image content type or nothing.
  const url = await imageFetchUrl(rawUrl);
  const res = await fetchImpl(url, {
    redirect: "manual",
    signal: AbortSignal.any([AbortSignal.timeout(IMAGE_FETCH_MS), signal]),
    headers: { accept: "image/*", "user-agent": "useful-bot/1.0" },
  });
  if (!res.ok) throw upstreamProtocolError();
  const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_MIME.test(mime)) throw upstreamProtocolError();
  const bytes = await readCappedBytes(res, IMAGE_BYTES_MAX);
  if (bytes.length === 0) throw upstreamProtocolError();
  return { bytes, mime };
}

function sniffMime(bytes: Buffer): string | null {
  if (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 6 && bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.length > 6 && bytes.subarray(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/**
 * One image generation against the resolved "image" role. Answers the
 * normalized {b64, mime} list the tool persists; url answers are downloaded
 * and re-encoded so the caller never holds a link that expires.
 */
export async function generateImage(input: {
  prompt: string;
  size?: ImageSize;
  n: number;
  /** One call's choice among the owner's image models; the saved role otherwise. */
  pick?: { connectionId?: string; modelId: string };
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ providerId: string; model: string; images: NormalizedImage[] }> {
  let store = readProviderStore();
  if (input.pick) {
    try {
      store = withImagePick(store, input.pick, process.env);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      // Anything else (a store that cannot be read) is a real fault, not a
      // wrong id, and goes up as one.
      if (code !== "image_model_unknown" && code !== "image_model_ambiguous") throw upstreamConfigError(error);
      throw new RouterError({ status: 400, type: "invalid_request_error", code, message: code });
    }
  }
  let resolved: ReturnType<typeof resolveUpstream>;
  try {
    resolved = resolveUpstream(store, "image", process.env);
  } catch (error) {
    throw upstreamConfigError(error);
  }
  const credential = resolved.credential;
  const auth = tokenFor(resolved.providerId, credential);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "useful-bot/1.0",
    ...(resolved.mode.headers ?? {}),
    ...auth.headers,
  };
  if (auth.token) {
    if (resolved.keyHeader === "x-api-key") headers["x-api-key"] = auth.token;
    else if (resolved.keyHeader === "api-key") headers["api-key"] = auth.token;
    else headers.authorization = `Bearer ${auth.token}`;
  }
  const url = `${resolved.baseUrl.replace(/\/$/, "")}/${resolved.mode.images?.path ?? "images/generations"}`;
  const doFetch = input.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: resolved.model,
      prompt: input.prompt,
      // dall-e-3 refuses anything but n=1; the response then carries one
      // image and the route bills for what arrived, not what was asked.
      n: imageFamily(resolved.providerId, resolved.model) === "dall-e-3" ? 1 : input.n,
      ...sizeParams(resolved.providerId, resolved.model, input.size,
        catalogFor(resolved.connection.id).find((item) => item.id === resolved.model)?.aspectRatios),
    }),
    redirect: "manual",
    signal: input.signal,
  });
  if (response.status >= 200 && response.status < 300) {
    clearConnectionError(resolved.connection.id);
  } else if (response.status >= 300 && response.status < 400) {
    throw new RouterError({
      status: 502,
      type: "upstream_error",
      code: "upstream_protocol_error",
      message: "upstream redirect rejected",
    });
  } else if (response.status === 401 || response.status === 403) {
    noteConnectionError(resolved.connection.id, "upstream_auth_failed");
    throw authFailed();
  } else if (response.status === 429) {
    throw await upstreamLimitError(response);
  } else if (response.status === 402) {
    // Marked on the connection, as the chat path does.
    noteConnectionError(resolved.connection.id, "upstream_quota_exhausted");
    throw await upstreamOutOfCredit(response, `${resolved.providerId}/${resolved.model}`);
  } else if (response.status === 404) {
    throw new RouterError({
      status: 502,
      type: "upstream_error",
      code: "model_unavailable",
      message: "model_unavailable",
    });
  } else {
    throw new RouterError({
      status: 502,
      type: "upstream_error",
      code: "upstream_protocol_error",
      message: "upstream_protocol_error",
    });
  }
  const bodyText = (await readCappedBytes(response, RESPONSE_MAX_BYTES)).toString("utf8");
  let json: { data?: unknown } | null;
  try {
    json = JSON.parse(bodyText || "null") as { data?: unknown } | null;
  } catch {
    throw upstreamProtocolError();
  }
  const data = Array.isArray(json?.data) ? json.data : null;
  if (!data || data.length === 0) throw upstreamProtocolError();
  const images: NormalizedImage[] = [];
  for (const item of data.slice(0, input.n)) {
    const rec = item && typeof item === "object" ? item as Record<string, unknown> : {};
    if (typeof rec.b64_json === "string" && rec.b64_json) {
      const bytes = Buffer.from(rec.b64_json, "base64");
      if (bytes.length === 0 || bytes.length > IMAGE_BYTES_MAX) throw upstreamProtocolError();
      const mime = sniffMime(bytes);
      if (!mime) throw upstreamProtocolError();
      images.push({ b64: rec.b64_json, mime });
      continue;
    }
    if (typeof rec.url === "string") {
      const fetched = await fetchImageBytes(rec.url, input.signal, doFetch);
      images.push({ b64: fetched.bytes.toString("base64"), mime: fetched.mime });
      continue;
    }
    throw upstreamProtocolError();
  }
  return { providerId: resolved.providerId, model: resolved.model, images };
}
