import { readFileSync } from 'node:fs';
import { createServer, get as httpGet, type IncomingMessage, type Server } from 'node:http';
import { get as httpsGet } from 'node:https';
import type { AddressInfo } from 'node:net';
import { connect, type TLSSocket } from 'node:tls';
import { HTTPS_SOCKET } from './systemd-socket.constants.js';
import { listenOnSockets, passedSockets, socketMismatch } from './systemd-socket.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/tls/${name}`, import.meta.url));
const certificate = { cert: fixture('cert.pem'), key: fixture('key.pem') };

const at = (address: string, port = 3000): AddressInfo => ({
  address,
  port,
  family: address.includes(':') ? 'IPv6' : 'IPv4',
});

describe('passedSockets', () => {
  it('none without systemd’s variables: the app listens on HOST and PORT itself', () => {
    expect(passedSockets({}, 4242)).toEqual([]);
    expect(passedSockets({ LISTEN_FDS: '1' }, 4242)).toEqual([]);
  });

  it('none when the variables name another process (inherited, not passed to this one)', () => {
    expect(passedSockets({ LISTEN_PID: '4243', LISTEN_FDS: '1' }, 4242)).toEqual([]);
    expect(passedSockets({ LISTEN_PID: '04242', LISTEN_FDS: '1' }, 4242)).toEqual([]);
  });

  it('the descriptors from 3 when they name this process, each with its unit’s name', () => {
    expect(passedSockets({ LISTEN_PID: '4242', LISTEN_FDS: '1' }, 4242)).toEqual([
      { fd: 3, name: '' },
    ]);
    expect(
      passedSockets(
        {
          LISTEN_PID: '4242',
          LISTEN_FDS: '4',
          LISTEN_FDNAMES: 'ilex.socket:ilex.socket:ilex-https.socket:ilex-https.socket',
        },
        4242,
      ),
    ).toEqual([
      { fd: 3, name: 'ilex.socket' },
      { fd: 4, name: 'ilex.socket' },
      { fd: 5, name: 'ilex-https.socket' },
      { fd: 6, name: 'ilex-https.socket' },
    ]);
  });

  it('refuses a count the two units never pass', () => {
    for (const count of [undefined, '', '0', '5', '-1', '1x', ' 1', '1.0']) {
      expect(
        () => passedSockets({ LISTEN_PID: '4242', LISTEN_FDS: count }, 4242),
        String(count),
      ).toThrow(/LISTEN_FDS/);
    }
  });
});

describe('socketMismatch', () => {
  it('127.0.0.1 (and the production default): 127.0.0.1 with ::1 beside it, or alone', () => {
    for (const host of ['127.0.0.1', undefined]) {
      expect(socketMismatch([at('127.0.0.1'), at('::1')], host, 3000)).toBeNull();
      expect(socketMismatch([at('127.0.0.1')], host, 3000)).toBeNull();
    }
  });

  it('::1 with 127.0.0.1 beside it; 0.0.0.0 with ::1', () => {
    expect(socketMismatch([at('::1'), at('127.0.0.1')], '::1', 3000)).toBeNull();
    expect(socketMismatch([at('0.0.0.0'), at('::1')], '0.0.0.0', 3000)).toBeNull();
  });

  it('every address of both kinds, or another address: that one alone', () => {
    expect(socketMismatch([at('::')], '::', 3000)).toBeNull();
    expect(socketMismatch([at('192.168.1.10')], '192.168.1.10', 3000)).toBeNull();
    expect(socketMismatch([at('fd00::5')], 'fd00:0:0::5', 3000)).toBeNull();
  });

  it('another port: says how to move the socket', () => {
    expect(socketMismatch([at('127.0.0.1'), at('::1')], '127.0.0.1', 3300)).toBe(
      'ilex.socket listens on 127.0.0.1:3000, [::1]:3000 — not on 127.0.0.1:3300 as HOST and ' +
        'PORT say. After a change to HOST or PORT in /etc/ilex/app.env: systemctl ' +
        'daemon-reload && systemctl restart ilex.socket',
    );
  });

  it('HOST’s own address missing, or one it doesn’t name', () => {
    expect(socketMismatch([at('::1')], '127.0.0.1', 3000)).toMatch(/^ilex.socket listens on/);
    expect(socketMismatch([at('::1')], '0.0.0.0', 3000)).toMatch(/not on 0.0.0.0:3000/);
    expect(socketMismatch([at('127.0.0.1'), at('0.0.0.0')], '127.0.0.1', 3000)).not.toBeNull();
    expect(socketMismatch([at('127.0.0.1')], '192.168.1.10', 3000)).not.toBeNull();
    expect(socketMismatch([at('0.0.0.0')], '::', 3000)).not.toBeNull();
    expect(socketMismatch([], '127.0.0.1', 3000)).toMatch(/listens on nothing/);
  });
});

describe('socketMismatch for HTTPS (ilex-https.socket)', () => {
  it('off: nothing passed and no HTTPS_HOST', () => {
    expect(socketMismatch([], undefined, 3443, HTTPS_SOCKET)).toBeNull();
  });

  it('every address, with ::1 beside it or alone; another address alone', () => {
    expect(
      socketMismatch([at('0.0.0.0', 3443), at('::1', 3443)], '0.0.0.0', 3443, HTTPS_SOCKET),
    ).toBeNull();
    expect(socketMismatch([at('0.0.0.0', 3443)], '0.0.0.0', 3443, HTTPS_SOCKET)).toBeNull();
    expect(socketMismatch([at('100.64.0.7', 3443)], '100.64.0.7', 3443, HTTPS_SOCKET)).toBeNull();
  });

  it('passed without HTTPS_HOST: says to set it or turn the socket off', () => {
    expect(socketMismatch([at('0.0.0.0', 3443)], undefined, 3443, HTTPS_SOCKET)).toMatch(
      /^ilex-https.socket listens on 0.0.0.0:3443, but HTTPS_HOST is not set\. .*disable --now ilex-https.socket/,
    );
  });

  it('HTTPS_HOST set but nothing passed, or elsewhere: names its own settings', () => {
    expect(socketMismatch([], '0.0.0.0', 3443, HTTPS_SOCKET)).toMatch(
      /^ilex-https.socket listens on nothing — not on 0.0.0.0:3443 as HTTPS_HOST and HTTPS_PORT say\. After a change to HTTPS_HOST/,
    );
    expect(socketMismatch([at('0.0.0.0', 3443)], '0.0.0.0', 8443, HTTPS_SOCKET)).not.toBeNull();
  });
});

describe('listenOnSockets', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });

  /** An HTTP server that answers with whether the request came over TLS. */
  function app(): Server {
    const server = createServer((request, response) => {
      response.end(JSON.stringify({ encrypted: (request.socket as TLSSocket).encrypted === true }));
    });
    servers.push(server);
    return server;
  }

  const local = { port: 0, host: '127.0.0.1' };

  /** The body at `url`; HTTPS trusting only the test certificate. */
  async function get(url: string): Promise<string> {
    const answer = await new Promise<IncomingMessage>((done, fail) =>
      (url.startsWith('https:')
        ? httpsGet(url, { ca: certificate.cert }, done)
        : httpGet(url, done)
      ).on('error', fail),
    );
    let body = '';
    for await (const chunk of answer) body += chunk;
    return body;
  }

  it('plain sockets: the first is the server’s, the others hand their connections over', async () => {
    const server = app();
    const listening = await listenOnSockets(server, [local, local]);
    expect(listening.encrypted).toEqual([]);
    for (const { port } of listening.plain) {
      expect(await get(`http://127.0.0.1:${port}/`)).toBe('{"encrypted":false}');
    }
  });

  it('an HTTPS socket: decrypted with the certificate, handed to the same server', async () => {
    const server = app();
    const listening = await listenOnSockets(server, [local], [local], certificate);
    const [https] = listening.encrypted;
    expect(await get(`https://localhost:${https!.port}/`)).toBe('{"encrypted":true}');
    expect(await get(`http://127.0.0.1:${listening.plain[0]!.port}/`)).toBe('{"encrypted":false}');
  });

  it('TLS 1.2 at least; a client refusing the certificate harms nothing', async () => {
    const server = app();
    const { encrypted } = await listenOnSockets(server, [local], [local], certificate);
    const port = encrypted[0]!.port;
    await expect(
      new Promise((done, fail) =>
        connect({ port, host: '127.0.0.1', ca: certificate.cert, maxVersion: 'TLSv1.1' }, () =>
          done('connected'),
        ).on('error', fail),
      ),
    ).rejects.toThrow();
    await expect(
      new Promise((done, fail) =>
        connect({ port, host: '127.0.0.1' }, () => done('connected')).on('error', fail),
      ),
    ).rejects.toThrow(/self-signed/);
    expect(await get(`https://localhost:${port}/`)).toBe('{"encrypted":true}');
  });

  it('the HTTPS sockets close with the server', async () => {
    const server = app();
    const { encrypted } = await listenOnSockets(server, [local], [local], certificate);
    servers.splice(0);
    await new Promise((done) => server.close(done));
    await expect(
      new Promise((done, fail) =>
        connect({ port: encrypted[0]!.port, host: '127.0.0.1', ca: certificate.cert }, () =>
          done('connected'),
        ).on('error', fail),
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('refuses an HTTPS socket without a certificate, and no plain socket at all', async () => {
    await expect(listenOnSockets(app(), [local], [local])).rejects.toThrow(/needs a certificate/);
    await expect(listenOnSockets(app(), [])).rejects.toThrow(/No socket/);
  });
});
