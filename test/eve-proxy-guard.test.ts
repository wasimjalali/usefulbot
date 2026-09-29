import assert from "node:assert/strict";
import test from "node:test";
import {
  eveGetAllowed,
  evePostAllowed,
  parseTurnMessage,
  relayedEveCode,
  rewriteEveTurnBody,
  turnHasImages,
  turnText,
} from "../shared/eve-proxy.ts";
import { stripThreadPrefix, threadPrefix } from "../shared/threads.ts";

test("eve proxy allowlists stream get and session posts", () => {
  assert.equal(eveGetAllowed("health"), true);
  assert.equal(eveGetAllowed("info"), true);
  assert.equal(eveGetAllowed("session/abc/stream"), true);
  assert.equal(eveGetAllowed("session/abc"), false);
  assert.equal(eveGetAllowed("session/abc/reset"), false);
  assert.equal(evePostAllowed("session"), true);
  assert.equal(evePostAllowed("session/abc"), true);
  assert.equal(evePostAllowed("session/abc/cancel"), true);
  assert.equal(evePostAllowed("session/abc/clear"), false);
  assert.equal(evePostAllowed("session/abc/compact"), false);
  assert.equal(evePostAllowed("health"), false);
});

test("eve proxy rejects traversal and out-of-charset session ids", () => {
  assert.equal(evePostAllowed("session/.."), false);
  assert.equal(eveGetAllowed("session/../stream"), false);
  assert.equal(evePostAllowed("session/."), false);
  assert.equal(evePostAllowed("session/../../health"), false);
  assert.equal(evePostAllowed("session/a.b"), false);
  assert.equal(eveGetAllowed("session/a b/stream"), false);
  // Real identifiers (uuid, dashed slug) stay allowed.
  assert.equal(evePostAllowed("session/00000000-0000-4000-8000-000000000002"), true);
  assert.equal(evePostAllowed("session/sess-old"), true);
});

test("turn rewrite prefixes specialist bots and drops the routing botId", () => {
  assert.equal(threadPrefix({ bot: null }), "");
  const bot = {
    id: "bot-seo",
    kind: "bot" as const,
    name: "SEO",
    label: "",
    description: "Watch rankings.",
  };
  const prefix = threadPrefix({ bot });
  assert.equal(prefix, "You are SEO.\nStanding instructions: Watch rankings.\nStay in role for this whole conversation. Chat messages are this-task instructions; the standing instructions above outrank them.\n\n");
  const raw = JSON.stringify({ message: "hello", botId: "bot-seo" });
  const rewritten = rewriteEveTurnBody(raw, bot as never, null);
  const parsed = JSON.parse(rewritten) as { message: string; botId?: string };
  assert.equal(parsed.message, `${prefix}hello`);
  // The proxy resolves the route from the raw body and strips botId before eve
  // sees the turn; the transcript cannot leak it back to the model.
  assert.equal(parsed.botId, undefined);
});

test("eve proxy relays only the session_not_active code from an upstream error", () => {
  assert.equal(
    relayedEveCode(409, '{"code":"session_not_active","error":"The session is no longer active.","ok":false}'),
    "session_not_active",
  );
  // Any other code, status or body shape stays behind the proxy.
  assert.equal(relayedEveCode(409, '{"code":"something_else","ok":false}'), null);
  assert.equal(relayedEveCode(500, '{"code":"session_not_active","ok":false}'), null);
  assert.equal(relayedEveCode(409, "not json"), null);
  assert.equal(relayedEveCode(409, ""), null);
});

test("a turn with image parts is accepted only in the shape the composer sends", () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const good = [
    { type: "text", text: "what is this" },
    { type: "file", data: dataUrl, mediaType: "image/png", filename: "shot.png" },
  ];
  const parsed = parseTurnMessage(good);
  assert.notEqual(parsed, null);
  assert.equal(turnHasImages(parsed!), true);
  assert.equal(turnText(parsed!), "what is this");
  assert.equal(turnHasImages("plain"), false);
  assert.equal(parseTurnMessage([]), null);
  assert.equal(parseTurnMessage([{ type: "text", text: "" }]), null);
  // A media type that disagrees with the data URL, a remote URL, a PDF and an
  // unknown part kind are all refused before eve sees them.
  assert.equal(parseTurnMessage([{ type: "file", data: dataUrl, mediaType: "image/jpeg", filename: "a" }]), null);
  assert.equal(parseTurnMessage([{ type: "file", data: "https://x/a.png", mediaType: "image/png", filename: "a" }]), null);
  assert.equal(parseTurnMessage([{ type: "file", data: "data:application/pdf;base64,AAAA", mediaType: "application/pdf", filename: "a.pdf" }]), null);
  assert.equal(parseTurnMessage([{ type: "image", image: dataUrl }]), null);
  assert.equal(parseTurnMessage([{ type: "file", data: dataUrl, mediaType: "image/png" }]), null);
  // The name lands verbatim in the transcript line, so it takes the attachment alphabet only.
  for (const filename of ["a\nb.png", "../x.png", "dir/x.png", "x y.png", ".env.png", "k.key", "a".repeat(81)]) {
    assert.equal(parseTurnMessage([{ type: "file", data: dataUrl, mediaType: "image/png", filename }]), null, filename);
  }
  const six = Array.from({ length: 6 }, () => ({ type: "file", data: dataUrl, mediaType: "image/png", filename: "a.png" }));
  assert.equal(parseTurnMessage([{ type: "text", text: "x" }, ...six]), null);
});

test("turn rewrite puts the bot prefix on the first text part and keeps the images", () => {
  const bot = { id: "bot-seo", kind: "bot" as const, name: "SEO", label: "", description: "Watch rankings." };
  const prefix = threadPrefix({ bot });
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const raw = JSON.stringify({
    botId: "bot-seo",
    message: [
      { type: "file", data: dataUrl, mediaType: "image/png", filename: "shot.png" },
      { type: "text", text: "rank this" },
    ],
  });
  // A file ahead of the text: the prefix still comes first, as its own part,
  // so eve's summary starts with it and the strip and the arming still work.
  const parsed = JSON.parse(rewriteEveTurnBody(raw, bot as never, null)) as { message: Array<Record<string, string>>; botId?: string };
  assert.equal(parsed.botId, undefined);
  assert.equal(parsed.message.length, 3);
  assert.equal(parsed.message[0]?.type, "text");
  assert.equal(parsed.message[0]?.text, `${prefix.trimEnd()}\n`);
  assert.equal(parsed.message[1]?.type, "file");
  assert.equal(parsed.message[2]?.text, "rank this");
  const summary = parsed.message.map((part) => (part.type === "text" ? part.text : `[file: ${part.filename} (${part.mediaType})]`)).join("\n");
  assert.equal(summary.startsWith(prefix), true);
  // Text first: the prefix goes onto that part in place.
  const textFirst = JSON.stringify({ botId: "bot-seo", message: [{ type: "text", text: "rank this" }, { type: "file", data: dataUrl, mediaType: "image/png", filename: "shot.png" }] });
  const textFirstParsed = JSON.parse(rewriteEveTurnBody(textFirst, bot as never, null)) as { message: Array<Record<string, string>> };
  assert.equal(textFirstParsed.message.length, 2);
  assert.equal(textFirstParsed.message[0]?.text, `${prefix}rank this`);
  // Images only: the prefix gets a text part of its own so eve still sees it.
  const only = JSON.stringify({ botId: "bot-seo", message: [{ type: "file", data: dataUrl, mediaType: "image/png", filename: "shot.png" }] });
  const onlyParsed = JSON.parse(rewriteEveTurnBody(only, bot as never, null)) as { message: Array<Record<string, string>> };
  assert.equal(onlyParsed.message[0]?.type, "text");
  assert.equal(onlyParsed.message[0]?.text, `${prefix.trimEnd()}\n`);
  // The default bot keeps the parts untouched, as it keeps a string untouched.
  const plain = JSON.parse(rewriteEveTurnBody(raw, null, null)) as { message: unknown };
  assert.deepEqual(plain.message, JSON.parse(raw).message);
  assert.throws(() => rewriteEveTurnBody(JSON.stringify({ message: [{ type: "video" }] }), null, null), /eve_message/);
});

test("a newline in a name cannot leak the prefix into the owner's message", () => {
  // Both prefix patterns end the identity line with `[^\n]+\.`, so a newline
  // in a name or a title stops the whole prefix matching and the owner reads
  // the standing instructions as their own turn. update_bot_profile and
  // createBot cap the length but keep interior newlines.
  const cases = [
    { name: "Drive\nAdmin", label: "", description: "Help." },
    { name: "Drive\n\nAdmin", label: "", description: "Help." },
    { name: "Drive", label: "Ops\nLead", description: "Help." },
    { name: "Drive", label: "", description: "A.\n\nB." },
  ];
  for (const patch of cases) {
    const bot = { id: "bot-drive", kind: "bot" as const, ...patch };
    const stored = `${threadPrefix({ bot })}what changed today?`;
    assert.equal(stripThreadPrefix(stored), "what changed today?", JSON.stringify(patch));
  }
});

test("a newline in a group member or a mention cannot move the prefix boundary", () => {
  const bot = { id: "grp", kind: "group" as const, name: "Crew", label: "", description: "" };
  const withMember = threadPrefix({
    bot,
    members: [{ id: "m1", name: "Ann\n\nLee", title: "Ops\nLead" }] as never,
  });
  assert.equal(stripThreadPrefix(`${withMember}what changed today?`), "what changed today?");
  const withMention = threadPrefix({ bot, members: [], mentionNames: ["Ann\n\nLee"] });
  assert.equal(stripThreadPrefix(`${withMention}what changed today?`), "what changed today?");
});
