import type { IncomingHttpHeaders } from 'node:http';

/**
 * Whether the page that opened the socket is served from this same host. Browsers send cookies on
 * cross-site WebSocket handshakes, so without this any website could open a socket with the
 * user's session (cross-site WebSocket hijacking). No `Origin` (not a browser) is refused too.
 */
export function isSameOrigin(headers: IncomingHttpHeaders): boolean {
  const { origin, host } = headers;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false; // "null" (sandboxed iframes, file://) or garbage
  }
}
