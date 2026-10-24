// Serves the built web app (SPA fallback) and proxies /api, WebSocket included, to the
// separate server — keeping the Host header, like the dev server's proxy. Screenshot use only.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const [root, port, target] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// The server's own security headers (helmet: the CSP and the rest), sent with the page too —
// production serves the page from the server, so the browser check should see the same.
const SECURITY = [
  'content-security-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'origin-agent-cluster',
  'referrer-policy',
  'x-content-type-options',
  'x-dns-prefetch-control',
  'x-download-options',
  'x-frame-options',
  'x-permitted-cross-domain-policies',
  'x-xss-protection',
];
let security = null;
async function securityHeaders() {
  if (security) return security;
  try {
    const answer = await fetch(`http://127.0.0.1:${target}/api/health`);
    security = Object.fromEntries(
      SECURITY.filter((name) => answer.headers.has(name)).map((name) => [
        name,
        answer.headers.get(name),
      ]),
    );
  } catch {
    return {};
  }
  return security;
}

const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api')) {
    const upstream = request(
      { host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
    return;
  }
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  for (const file of [join(root, path), join(root, 'index.html')]) {
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        ...(await securityHeaders()),
        'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      });
      return res.end(body);
    } catch {}
  }
  res.writeHead(404).end();
});

server.on('upgrade', (req, socket, head) => {
  const upstream = connect(target, '127.0.0.1', () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n')}\r\n\r\n`,
    );
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(port, '127.0.0.1', () => console.log(`serving ${root} on ${port}, /api → ${target}`));
