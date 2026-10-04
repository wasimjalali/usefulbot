/**
 * openai-chat protocol: POST {baseUrl}/chat/completions with the
 * chat-completions body the router built. No translation either way.
 */
import { dumpUpstreamBody } from "../payload-probe.ts";

export async function postChatCompletions(input: {
  baseUrl: string;
  body: unknown;
  headers: Record<string, string>;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  dumpUpstreamBody("openai-chat", String((input.body as { model?: unknown } | null)?.model ?? "unknown"), input.body);
  const url = `${input.baseUrl.replace(/\/$/, "")}/chat/completions`;
  return (input.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify(input.body),
    redirect: "manual",
    signal: input.signal,
  });
}
