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

// The server's own headers (helmet: the CSP and the rest), sent with the page too — production
// serves the page from the server, so the browser check sees the same. All of them but those
// about the answer itself; read once. Without them no page is served (a check would test nothing).
const NOT_COPIED = new Set([
  'content-type',
  'content-length',
  'etag',
  'date',
  'connection',
  'keep-alive',
  'cache-control',
  'transfer-encoding',
  'vary',
]);
let security = null;
async function securityHeaders() {
  if (security) return security;
  const answer = await fetch(`http://127.0.0.1:${target}/api/health`);
  await answer.arrayBuffer();
  if (!answer.ok) throw new Error(`/api/health answered ${answer.status}`);
  security = Object.fromEntries([...answer.headers].filter(([name]) => !NOT_COPIED.has(name)));
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
  let headers;
  try {
    headers = await securityHeaders();
  } catch (error) {
    console.error(`No security headers from the server (${error.message}): page not served`);
    return res.writeHead(503).end();
  }
  for (const file of [join(root, path), join(root, 'index.html')]) {
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        ...headers,
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
