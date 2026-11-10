import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SEND_TIMEOUT_MS } from './alerts.constants.js';
import { NtfySender } from './ntfy-sender.js';
import type { Lookup } from './safe-address.js';

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

const MESSAGE = {
  title: 'Immich has stopped',
  body: 'On box, since 14:02.',
  severity: 'critical' as const,
};

describe('NtfySender', () => {
  let server: Server;
  let port: number;
  let received: Received[];
  let answer: (req: IncomingMessage, res: ServerResponse) => void;

  beforeEach(async () => {
    received = [];
    answer = (_req, res) => res.writeHead(200).end('{"id":"x"}');
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk: Buffer) => (data += chunk.toString()));
      req.on('end', () => {
        received.push({
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body: JSON.parse(data || 'null'),
        });
        answer(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const sender = (lookup?: Lookup) => new NtfySender(lookup);

  it('posts the message as JSON to the server, the topic inside', async () => {
    await sender().send(
      { kind: 'ntfy', topicUrl: `http://127.0.0.1:${port}/ilex-7f3k`, token: null },
      MESSAGE,
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: 'POST', url: '/' });
    expect(received[0].headers['content-type']).toBe('application/json');
    expect(received[0].headers.authorization).toBeUndefined();
    expect(received[0].body).toEqual({
      topic: 'ilex-7f3k',
      title: 'Immich has stopped',
      message: 'On box, since 14:02.',
      priority: 4,
      tags: ['rotating_light'],
    });
  });

  it('keeps a server’s subpath and sends the token as a bearer', async () => {
    await sender().send(
      { kind: 'ntfy', topicUrl: `http://127.0.0.1:${port}/ntfy/alerts`, token: 'tk_secret' },
      { ...MESSAGE, severity: 'resolved' },
    );
    expect(received[0].url).toBe('/ntfy/');
    expect(received[0].headers.authorization).toBe('Bearer tk_secret');
    expect(received[0].body).toMatchObject({ topic: 'alerts', priority: 2 });
  });

  it('connects to the address it checked (the name is resolved once)', async () => {
    let lookups = 0;
    const lookup: Lookup = async () => {
      lookups++;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    await sender(lookup).send(
      { kind: 'ntfy', topicUrl: `http://ntfy.home.arpa:${port}/t`, token: null },
      MESSAGE,
    );
    expect(lookups).toBe(1);
    expect(received[0].headers.host).toBe(`ntfy.home.arpa:${port}`);
  });

  it('doesn’t follow redirects', async () => {
    answer = (_req, res) => res.writeHead(302, { Location: 'http://169.254.169.254/' }).end();
    await expect(
      sender().send({ kind: 'ntfy', topicUrl: `http://127.0.0.1:${port}/t`, token: null }, MESSAGE),
    ).rejects.toMatchObject({ problem: 'rejected' });
    expect(received).toHaveLength(1);
  });

  it('a refused token: loginRefused; a server error: failed', async () => {
    answer = (_req, res) => res.writeHead(403).end();
    await expect(
      sender().send(
        { kind: 'ntfy', topicUrl: `http://127.0.0.1:${port}/t`, token: 'wrong' },
        MESSAGE,
      ),
    ).rejects.toMatchObject({ problem: 'loginRefused' });
    answer = (_req, res) => res.writeHead(500).end();
    await expect(
      sender().send({ kind: 'ntfy', topicUrl: `http://127.0.0.1:${port}/t`, token: null }, MESSAGE),
    ).rejects.toMatchObject({ problem: 'failed' });
  });

  it('refuses plain HTTP to the internet before connecting', async () => {
    const publicLookup: Lookup = async () => [{ address: '159.203.148.75', family: 4 }];
    await expect(
      sender(publicLookup).send(
        { kind: 'ntfy', topicUrl: 'http://ntfy.sh/t', token: null },
        MESSAGE,
      ),
    ).rejects.toMatchObject({ problem: 'addressRefused' });
    expect(received).toHaveLength(0);
  });

  it('nothing listening: unreachable', async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await expect(
      sender().send({ kind: 'ntfy', topicUrl: `http://127.0.0.1:${port}/t`, token: null }, MESSAGE),
    ).rejects.toMatchObject({ problem: 'unreachable' });
    server = createServer();
    server.listen(0);
  });

  it('gives up when there’s no answer in time (10 s)', async () => {
    expect(SEND_TIMEOUT_MS).toBe(10_000);
    answer = () => undefined; // never answers
    await expect(
      new NtfySender(undefined, 50).send(
        { kind: 'ntfy', topicUrl: `http://127.0.0.1:${port}/t`, token: null },
        MESSAGE,
      ),
    ).rejects.toMatchObject({ problem: 'timedOut' });
  });
});
