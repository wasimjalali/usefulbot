import { wrapUntrusted } from "../../shared/untrusted.ts";

/**
 * A fetched page is outside text: whoever controls it controls what the bot
 * reads. eve's own `web_fetch` returns it bare, so the override in
 * agent/tools/web_fetch.ts passes the result through here, and the body
 * arrives in the same envelope `web_search` and `bash` output use.
 */
type Fetched = { content: string };

export function fenceWebFetchResult<T extends Fetched>(result: T): T {
  return { ...result, content: wrapUntrusted("web fetch", result.content) };
}

/** eve's tool results may be a value, a promise or a stream; every one that carries page text is fenced. */
export function fenceWebFetch<T extends Fetched>(result: T | Promise<T> | AsyncIterable<T>): Promise<T> | AsyncIterable<T> {
  if (result && typeof (result as AsyncIterable<T>)[Symbol.asyncIterator] === "function") {
    const stream = result as AsyncIterable<T>;
    return (async function* () {
      for await (const chunk of stream) yield fenceWebFetchResult(chunk);
    })();
  }
  return Promise.resolve(result as T | Promise<T>).then(fenceWebFetchResult);
}
