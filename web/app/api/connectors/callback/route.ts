export const runtime = "nodejs";

/**
 * Where Composio sends the browser after the hosted OAuth page. It is a
 * loopback landing page and nothing more: no session, no query parsing, no
 * state change. The dialog learns about the new connection by polling the
 * connectors route, which asks Composio.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Useful Bot</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f5f2; color: #1b1a17; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
  main { text-align: center; padding: 32px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0; color: #6b675f; }
  @media (prefers-color-scheme: dark) { body { background: #141311; color: #f1efe9; } p { color: #a7a29a; } }
</style>
</head>
<body>
<main>
  <h1>Connected</h1>
  <p>You can close this tab and return to Useful Bot.</p>
</main>
</body>
</html>
`;

export function GET() {
  return new Response(PAGE, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    },
  });
}
