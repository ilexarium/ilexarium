import { connect as http2Connect } from 'node:http2';
import { connect } from 'node:net';
import { proxy, proxyReachable } from './docker-proxy.js';

// The allow-list in system/docker-socket-proxy/haproxy.cfg, against the running dev proxy and
// the real Docker daemon behind it. Every refusal must come from the proxy (403), never Docker.

const reachable = await proxyReachable();
if (!reachable) console.warn('Docker socket proxy not reachable — run `npm run db:up`. Skipping.');

async function status(path: string, method = 'GET', headers: Record<string, string> = {}) {
  const res = await fetch(`${proxy.http}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(5000),
  });
  await res.body?.cancel();
  return res.status;
}

/** Sends raw bytes and returns the status code of every response (HTTP/1.0 or 1.1). */
function rawStatuses(request: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.port, proxy.host);
    let received = '';
    socket.on('data', (chunk) => (received += chunk.toString('latin1')));
    socket.on('error', reject);
    socket.on('close', () =>
      resolve([...received.matchAll(/^HTTP\/1\.[01] (\d{3})/gm)].map((match) => Number(match[1]))),
    );
    socket.setTimeout(3000, () => socket.end());
    socket.write(request);
  });
}

describe.skipIf(!reachable)('Docker socket proxy (e2e, real Docker)', () => {
  let containerId: string;

  beforeAll(async () => {
    const res = await fetch(`${proxy.http}/containers/json?all=true`);
    const containers = (await res.json()) as { Id: string }[];
    expect(containers.length).toBeGreaterThan(0); // at least the dev Postgres
    containerId = containers[0].Id;
  });

  it('passes the allowed reads', async () => {
    for (const path of [
      '/_ping',
      '/version',
      '/containers/json?all=true',
      '/v1.47/containers/json',
      `/containers/${containerId}/json`,
      `/containers/${containerId}/stats?stream=false`,
    ]) {
      expect(await status(path), path).toBe(200);
    }
    expect(await status('/_ping', 'HEAD')).toBe(200);
  });

  it('streams events', async () => {
    const controller = new AbortController();
    const res = await fetch(`${proxy.http}/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    controller.abort();
  });

  it('refuses every write', async () => {
    for (const [method, path] of [
      ['POST', '/containers/create'],
      ['POST', `/containers/${containerId}/stop`],
      ['POST', `/containers/${containerId}/restart`],
      ['POST', `/containers/${containerId}/exec`],
      ['DELETE', `/containers/${containerId}`],
      ['POST', '/images/create'],
      ['POST', '/build'],
      ['PUT', `/containers/${containerId}/archive?path=/tmp`],
      ['POST', '/v1.47/containers/create'],
    ]) {
      expect(await status(path, method), `${method} ${path}`).toBe(403);
    }
  });

  it('refuses reads that are not on the list', async () => {
    for (const path of [
      `/containers/${containerId}/export`,
      `/containers/${containerId}/archive?path=/etc`,
      `/containers/${containerId}/logs`,
      `/containers/${containerId}/top`,
      `/containers/${containerId}/changes`,
      '/images/json',
      '/info',
      '/volumes',
      '/networks',
      '/secrets',
      '/system/df',
    ]) {
      expect(await status(path), path).toBe(403);
    }
    expect(await status('/version', 'HEAD')).toBe(403);
  });

  it('refuses path tricks', async () => {
    for (const path of [
      '/containers/..%2F..%2Fimages/json',
      '/containers/%2e%2e/json',
      '//containers/json',
      '/containers/a/b/json',
      '/containers/json/',
      '/v1.47/v1.47/containers/json',
      '/vx/containers/json',
    ]) {
      expect(await status(path), path).toBe(403);
    }
    // Unnormalised dot segments (fetch would clean them, so raw bytes).
    for (const path of ['/containers/../info', `/containers/${containerId}/../../info`]) {
      expect(
        await rawStatuses(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`),
        path,
      ).toEqual([403]);
    }
  });

  it('refuses connection upgrades (attach/exec hijacking)', async () => {
    const statuses = await rawStatuses(
      'GET /containers/json HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
    );
    expect(statuses).toEqual([403]);
  });

  it('checks every request on a kept-alive connection, not just the first', async () => {
    const statuses = await rawStatuses(
      'GET /_ping HTTP/1.1\r\nHost: x\r\n\r\n' +
        'POST /containers/create HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}' +
        'GET /info HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
    );
    expect(statuses[0]).toBe(200);
    expect(statuses.slice(1).every((line) => line === 403)).toBe(true);
  });

  it('refuses a full URL as the request target', async () => {
    const statuses = await rawStatuses(
      `GET http://docker/containers/${containerId}/export HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    );
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).not.toBe(200);
  });
  it('refuses other spellings: lowercase methods, different-case paths, paths hidden in the query', async () => {
    expect(
      await rawStatuses('get /containers/json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'),
    ).not.toEqual([200]);
    for (const path of ['/Containers/json', '/CONTAINERS/JSON', '/Events']) {
      expect(await status(path), path).toBe(403);
    }
    // The query is not part of the path Docker routes on — still the (allowed) list:
    expect(await status('/containers/json?x=/../../images/json')).toBe(200);
    expect(await status(`/containers/${containerId}/export?x=/json`)).toBe(403);
  });

  it('applies the same rules to HTTP/1.0', async () => {
    expect(await rawStatuses('GET /_ping HTTP/1.0\r\n\r\n')).toEqual([200]);
    const refused = await rawStatuses(
      'POST /containers/create HTTP/1.0\r\nContent-Length: 0\r\n\r\n',
    );
    expect(refused).toEqual([403]);
  });

  it('cannot be smuggled past: a second request hidden in a body is checked or rejected', async () => {
    // Content-Length and Transfer-Encoding together (CL.TE / TE.CL): HAProxy must either reject
    // the request or treat what follows as its own request — which the rules then refuse.
    const hidden = 'POST /containers/create HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n';
    const statuses = await rawStatuses(
      'GET /_ping HTTP/1.1\r\nHost: x\r\n' +
        `Content-Length: ${hidden.length + 5}\r\nTransfer-Encoding: chunked\r\n\r\n` +
        `0\r\n\r\n${hidden}`,
    );
    expect(statuses.length).toBeGreaterThan(0);
    // Whatever HAProxy makes of it, no write ever succeeds: every response after a refusal or a
    // reject is an error, and nothing but the ping may be a 200.
    expect(statuses.filter((line) => line === 200).length).toBeLessThanOrEqual(1);
    expect(statuses.slice(1).every((line) => line !== 201 && line !== 200)).toBe(true);
  });

  it('applies the same rules over HTTP/2 without TLS (h2c), if it is accepted at all', async () => {
    const session = http2Connect(proxy.http);
    const result = await new Promise<number | 'refused'>((resolve) => {
      session.on('error', () => resolve('refused'));
      const req = session.request({ ':method': 'POST', ':path': '/containers/create' });
      req.on('response', (headers) => resolve(Number(headers[':status'])));
      req.on('error', () => resolve('refused'));
      req.end();
    });
    session.destroy();
    expect([403, 'refused']).toContain(result);
  });

  it('runs the proxy container locked down', async () => {
    const res = await fetch(`${proxy.http}/containers/json?all=true`);
    const containers = (await res.json()) as { Id: string; Names: string[] }[];
    const proxyContainer = containers.find((c) => c.Names.some((n) => n.includes('docker-proxy')));
    expect(proxyContainer, 'the dev docker-proxy container').toBeDefined();
    const details = (await (
      await fetch(`${proxy.http}/containers/${proxyContainer!.Id}/json`)
    ).json()) as {
      Config: { User: string; Image: string };
      HostConfig: {
        ReadonlyRootfs: boolean;
        CapDrop: string[] | null;
        CapAdd: string[] | null;
        SecurityOpt: string[] | null;
        Privileged: boolean;
        PortBindings: Record<string, { HostIp: string; HostPort: string }[]>;
      };
    };
    expect(details.Config.User).toBe('haproxy');
    expect(details.Config.Image).toMatch(/^haproxy:[\w.-]+@sha256:[0-9a-f]{64}$/);
    expect(details.HostConfig.ReadonlyRootfs).toBe(true);
    expect(details.HostConfig.CapDrop).toEqual(['ALL']);
    expect(details.HostConfig.CapAdd ?? []).toEqual([]);
    expect(details.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
    expect(details.HostConfig.Privileged).toBe(false);
    for (const bindings of Object.values(details.HostConfig.PortBindings)) {
      for (const { HostIp } of bindings) expect(HostIp).toBe('127.0.0.1');
    }
  });
});
