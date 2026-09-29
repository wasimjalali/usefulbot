function defaultPort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1"
    || hostname === "localhost"
    || hostname === "::1"
    || hostname === "[::1]";
}

/** True when the request URL itself is loopback. Fail closed on parse errors. */
export function requestIsLoopback(requestUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(requestUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function originHeaderAllowed(origin: string | null, requestUrl: string): boolean {
  if (!origin) return true;
  try {
    const remote = new URL(origin);
    const self = new URL(requestUrl);
    if (!isLoopbackHost(remote.hostname) || !isLoopbackHost(self.hostname)) return false;
    return defaultPort(remote) === defaultPort(self);
  } catch {
    return false;
  }
}
