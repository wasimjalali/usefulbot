// Feedback from the Useful Bot macOS app. D1 is the source of truth; email only notifies.
// Contract: POST /v1/feedback, see README.md.

const KINDS = ["idea", "problem", "other"] as const;
type Kind = (typeof KINDS)[number];

const MAX_MESSAGE = 4000; // code points, matches the CHECK in migrations/0001_feedback.sql
const MAX_BODY_BYTES = 32 * 1024;
const PER_INSTALL_PER_DAY = 5;
const PER_NETWORK_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_MAX_ITEMS = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// No whitespace or control characters, so it can't smuggle a header into Reply-To.
const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const CONTEXT_VALUE = /^[\x20-\x7E]{1,64}$/;
const CONTEXT_KEYS = ["appVersion", "build", "macosVersion", "chip"] as const;

interface Feedback {
  kind: Kind;
  message: string;
  replyEmail: string | null;
  installId: string;
  context: Record<(typeof CONTEXT_KEYS)[number], string | null>;
}

class Invalid extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/feedback") return json(404, { ok: false, error: "not_found" });
    if (request.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
    }
    try {
      return await submit(request, env, ctx);
    } catch (error) {
      log("error", "submit_failed", { error: String(error) });
      return json(500, { ok: false, error: "server" });
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(sendDigest(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

async function submit(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return json(415, { ok: false, error: "unsupported_media_type" });
  }
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return json(413, { ok: false, error: "too_large" });

  let feedback: Feedback;
  try {
    feedback = parse(text);
  } catch (error) {
    if (error instanceof Invalid) {
      return json(400, { ok: false, error: "invalid", field: error.field, message: error.message });
    }
    throw error;
  }

  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) throw new Error("request has no CF-Connecting-IP");
  if (!env.IP_SALT) throw new Error("IP_SALT secret is not set");
  const ipHash = await hmacHex(env.IP_SALT, ip);

  const id = crypto.randomUUID();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const since = new Date(now - DAY_MS).toISOString();

  // Check both limits and insert in one statement, so parallel sends can't slip past them.
  const result = await env.DB.prepare(
    `INSERT INTO feedback
       (id, created_at, kind, message, reply_email, app_version, build, macos_version, chip, install_id, ip_hash)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
     WHERE (SELECT count(*) FROM feedback WHERE install_id = ?10 AND created_at > ?12) < ?13
       AND (SELECT count(*) FROM feedback WHERE ip_hash = ?11 AND created_at > ?12) < ?14`,
  )
    .bind(
      id,
      createdAt,
      feedback.kind,
      feedback.message,
      feedback.replyEmail,
      feedback.context.appVersion,
      feedback.context.build,
      feedback.context.macosVersion,
      feedback.context.chip,
      feedback.installId,
      ipHash,
      since,
      PER_INSTALL_PER_DAY,
      PER_NETWORK_PER_DAY,
    )
    .run();

  if (result.meta.changes !== 1) {
    return rateLimited(env, feedback.installId, ipHash, since, now);
  }

  log("info", "feedback_stored", { id, kind: feedback.kind });
  if (feedback.kind === "problem") {
    ctx.waitUntil(sendProblem(env, id, createdAt, feedback));
  }
  return json(201, { ok: true, id });
}

async function rateLimited(env: Env, installId: string, ipHash: string, since: string, now: number) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM feedback WHERE install_id = ?1 AND created_at > ?3) AS install_count,
       (SELECT min(created_at) FROM feedback WHERE install_id = ?1 AND created_at > ?3) AS install_oldest,
       (SELECT count(*) FROM feedback WHERE ip_hash = ?2 AND created_at > ?3) AS network_count,
       (SELECT min(created_at) FROM feedback WHERE ip_hash = ?2 AND created_at > ?3) AS network_oldest`,
  )
    .bind(installId, ipHash, since)
    .first<{
      install_count: number;
      install_oldest: string | null;
      network_count: number;
      network_oldest: string | null;
    }>();
  if (!row) throw new Error("rate limit lookup returned no row");

  // A slot frees when the oldest send in the full window turns 24 hours old.
  const waits: number[] = [];
  if (row.install_count >= PER_INSTALL_PER_DAY && row.install_oldest) {
    waits.push(Date.parse(row.install_oldest) + DAY_MS - now);
  }
  if (row.network_count >= PER_NETWORK_PER_DAY && row.network_oldest) {
    waits.push(Date.parse(row.network_oldest) + DAY_MS - now);
  }
  // The oldest send can expire between the insert and this lookup: then a retry fits right away.
  if (waits.length === 0) log("info", "rate_limit_window_moved", {});
  const retryAfter = Math.max(1, Math.ceil(Math.max(0, ...waits) / 1000));
  const scope = row.install_count >= PER_INSTALL_PER_DAY ? "install" : "network";
  log("info", "feedback_rate_limited", { scope });
  return json(
    429,
    { ok: false, error: "rate_limited", scope, message: "You've reached today's feedback limit. Try again tomorrow." },
    { "Retry-After": String(retryAfter) },
  );
}

function parse(text: string): Feedback {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Invalid("body", "Body isn't valid JSON.");
  }
  if (!isRecord(body)) throw new Invalid("body", "Body must be a JSON object.");

  const kind = body.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    throw new Invalid("kind", "kind must be idea, problem or other.");
  }

  if (typeof body.message !== "string") throw new Invalid("message", "message must be a string.");
  const message = body.message.trim();
  const length = [...message].length;
  if (length === 0) throw new Invalid("message", "message is empty.");
  if (length > MAX_MESSAGE) throw new Invalid("message", `message is over ${MAX_MESSAGE} characters.`);

  let replyEmail: string | null = null;
  if (body.replyEmail !== undefined && body.replyEmail !== null) {
    if (typeof body.replyEmail !== "string") throw new Invalid("replyEmail", "replyEmail must be a string.");
    const email = body.replyEmail.trim();
    if (email !== "") {
      if (email.length > 254 || !EMAIL.test(email)) throw new Invalid("replyEmail", "replyEmail isn't an email address.");
      replyEmail = email;
    }
  }

  if (typeof body.installId !== "string" || !UUID.test(body.installId)) {
    throw new Invalid("installId", "installId must be a UUID.");
  }
  const installId = body.installId.toLowerCase();

  const context: Feedback["context"] = { appVersion: null, build: null, macosVersion: null, chip: null };
  if (body.context !== undefined && body.context !== null) {
    if (!isRecord(body.context)) throw new Invalid("context", "context must be an object or null.");
    for (const key of CONTEXT_KEYS) {
      const value = body.context[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || !CONTEXT_VALUE.test(value)) {
        throw new Invalid(`context.${key}`, `context.${key} must be 1 to 64 printable characters.`);
      }
      context[key] = value;
    }
  }

  return { kind: kind as Kind, message, replyEmail, installId, context };
}

async function sendProblem(env: Env, id: string, createdAt: string, feedback: Feedback): Promise<void> {
  const firstLine = feedback.message.split("\n", 1)[0].replace(/\s+/g, " ").trim();
  const subject = `Problem: ${truncate(firstLine, 70)}`;
  const details = contextLines(feedback.context, feedback.replyEmail);
  const text = [feedback.message, "", ...details, `ID: ${id}`, `Sent: ${createdAt}`].join("\n");
  const html = [
    `<p style="white-space:pre-wrap">${escapeHtml(feedback.message)}</p>`,
    `<p style="color:#5c5c5c">${[...details, `ID: ${id}`, `Sent: ${createdAt}`].map(escapeHtml).join("<br>")}</p>`,
  ].join("\n");
  try {
    const sent = await env.EMAIL.send({
      from: { email: env.FROM_ADDRESS, name: "Useful Bot feedback" },
      to: env.TO_ADDRESS,
      ...(feedback.replyEmail ? { replyTo: feedback.replyEmail } : {}),
      subject,
      text,
      html,
    });
    log("info", "problem_email_sent", { id, messageId: sent.messageId });
  } catch (error) {
    // The row is already in D1 and the weekly digest carries it; this alert is what failed.
    log("error", "problem_email_failed", { id, error: String(error) });
  }
}

async function sendDigest(env: Env, scheduledTime: number): Promise<void> {
  const end = new Date(scheduledTime).toISOString();
  const start = new Date(scheduledTime - 7 * DAY_MS).toISOString();
  const counts = await env.DB.prepare(
    `SELECT kind, count(*) AS n FROM feedback WHERE created_at >= ?1 AND created_at < ?2 GROUP BY kind`,
  )
    .bind(start, end)
    .all<{ kind: Kind; n: number }>();
  const byKind: Record<Kind, number> = { idea: 0, problem: 0, other: 0 };
  for (const row of counts.results) byKind[row.kind] = row.n;
  const total = byKind.idea + byKind.problem + byKind.other;

  const rows = await env.DB.prepare(
    `SELECT id, created_at, kind, message, reply_email, app_version, build, macos_version, chip
     FROM feedback WHERE created_at >= ?1 AND created_at < ?2 ORDER BY created_at LIMIT ?3`,
  )
    .bind(start, end, DIGEST_MAX_ITEMS)
    .all<{
      id: string;
      created_at: string;
      kind: Kind;
      message: string;
      reply_email: string | null;
      app_version: string | null;
      build: string | null;
      macos_version: string | null;
      chip: string | null;
    }>();

  const summary = `${total} this week: ${byKind.idea} ideas, ${byKind.problem} problems, ${byKind.other} other.`;
  const items = rows.results.map((row) => {
    const details = contextLines(
      { appVersion: row.app_version, build: row.build, macosVersion: row.macos_version, chip: row.chip },
      row.reply_email,
    );
    return { head: `${label(row.kind)} · ${row.created_at}`, body: row.message, details: [...details, `ID: ${row.id}`] };
  });
  const more = total > items.length ? `And ${total - items.length} more in D1.` : "";

  const text = [
    summary,
    `Week: ${start} to ${end}`,
    "",
    ...items.flatMap((item) => [item.head, item.body, ...item.details, ""]),
    more,
  ].join("\n");
  const html = [
    `<p><strong>${escapeHtml(summary)}</strong><br><span style="color:#5c5c5c">Week: ${escapeHtml(start)} to ${escapeHtml(end)}</span></p>`,
    ...items.map(
      (item) =>
        `<hr><p><strong>${escapeHtml(item.head)}</strong></p><p style="white-space:pre-wrap">${escapeHtml(item.body)}</p>` +
        `<p style="color:#5c5c5c">${item.details.map(escapeHtml).join("<br>")}</p>`,
    ),
    more ? `<p>${escapeHtml(more)}</p>` : "",
  ].join("\n");

  // Let a failure throw: the cron run shows as failed in the Worker's logs.
  const sent = await env.EMAIL.send({
    from: { email: env.FROM_ADDRESS, name: "Useful Bot feedback" },
    to: env.TO_ADDRESS,
    subject: `Feedback this week: ${total}`,
    text,
    html,
  });
  log("info", "digest_sent", { total, messageId: sent.messageId });
}

function contextLines(context: Feedback["context"], replyEmail: string | null): string[] {
  const lines: string[] = [];
  if (replyEmail) lines.push(`Reply to: ${replyEmail}`);
  const app = [context.appVersion, context.build ? `(${context.build})` : null].filter(Boolean).join(" ");
  if (app) lines.push(`Useful Bot ${app}`);
  if (context.macosVersion) lines.push(`macOS ${context.macosVersion}`);
  if (context.chip) lines.push(context.chip);
  return lines;
}

function label(kind: Kind): string {
  return kind === "idea" ? "Idea" : kind === "problem" ? "Problem" : "Other";
}

async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function log(level: "info" | "error", event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
