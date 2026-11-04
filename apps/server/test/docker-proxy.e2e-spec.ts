import { connect as http2Connect } from 'node:http2';
import { connect } from 'node:net';
import { proxy, proxyReachable } from './docker-proxy.js';

// The allow-list in system/docker-socket-proxy/haproxy.cfg, against the running dev proxy and
// the real Docker daemon behind it. Every refusal must come from the proxy (403), never Docker.
// The write tests only ever touch the dev sandbox container and volumes that can't be deleted
// (in use, or missing). The prunes are never run here: they'd delete the developer's own unused
// images — the install test runs them (tools/vm/smoke.mjs).

const SANDBOX = 'laris-dev-sandbox-1';
/** The dev Postgres's volume: always in use, so Docker itself refuses to delete it. */
const VOLUME_IN_USE = 'laris-dev_pgdata';
const IMAGE_PRUNE_QUERY = `filters=${encodeURIComponent('{"dangling":["false"]}')}`;

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
  let containerName: string;

  /** The dev sandbox (busybox, not protected): the only container these tests change. */
  let sandbox: string;
  let sandboxId: string;

  beforeAll(async () => {
    const res = await fetch(`${proxy.http}/containers/json?all=true`);
    const containers = (await res.json()) as { Id: string; Names: string[] }[];
    expect(containers.length).toBeGreaterThan(0); // at least the dev Postgres
    containerId = containers[0].Id;
    containerName = containers[0].Names[0].replace(/^\//, '');
    const found = containers.find((c) => c.Names.includes(`/${SANDBOX}`));
    expect(found, `${SANDBOX} — run npm run db:up`).toBeDefined();
    sandbox = SANDBOX;
    sandboxId = found!.Id;
  });

  afterAll(async () => {
    // Leave the sandbox running, whatever happened above.
    await status(`/containers/${SANDBOX}/start`, 'POST').catch(() => undefined);
  });

  it('passes the three container actions, by name and by ID', async () => {
    expect(await status(`/containers/${sandbox}/stop`, 'POST')).toBe(204);
    expect(await status(`/containers/${sandbox}/stop`, 'POST')).toBe(304); // Docker: already stopped
    expect(await status(`/containers/${sandboxId}/start`, 'POST')).toBe(204);
    expect(await status(`/v1.40/containers/${sandbox}/restart`, 'POST')).toBe(204);
    expect(await status(`/v1.56/containers/${sandboxId}/restart`, 'POST')).toBe(204);
    // An explicit empty body is no body.
    expect(
      await rawStatuses(
        `POST /containers/${sandbox}/start HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      ),
    ).toEqual([304]); // already started
  });

  it('allows the actions for POST only', async () => {
    for (const action of ['start', 'stop', 'restart']) {
      for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
        const path = `/containers/${sandbox}/${action}`;
        expect(await status(path, method), `${method} ${path}`).toBe(403);
      }
    }
  });

  it('refuses look-alikes of the action paths', async () => {
    for (const path of [
      `/containers/${sandbox}/start/`,
      `/containers/${sandbox}/startx`,
      `/containers/${sandbox}/stop/x`,
      `/containers/${sandbox}/START`,
      `/containers/${sandbox}/Restart`,
      `/containers/a/${sandbox}/stop`,
      `/containers/.${sandbox}/stop`,
      `/containers/-${sandbox}/stop`,
      `/containers/${sandbox}%2Fstop`,
      '/containers/start',
      '/containers//stop',
      `//containers/${sandbox}/stop`,
      `/v1.47/v1.47/containers/${sandbox}/stop`,
    ]) {
      expect(await status(path, 'POST'), path).toBe(403);
    }
    for (const path of [
      `/containers/${sandbox}/x/../stop`,
      `/containers/../containers/${sandbox}/stop`,
    ]) {
      expect(
        await rawStatuses(`POST ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`),
        path,
      ).toEqual([403]);
    }
  });

  it('refuses the actions with a body', async () => {
    // Old API versions let start carry host settings (mounts, privileges).
    const settings = JSON.stringify({ Binds: ['/:/host'], Privileged: true });
    for (const action of ['start', 'stop', 'restart']) {
      const path = `/containers/${sandbox}/${action}`;
      const res = await fetch(`${proxy.http}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: settings,
        signal: AbortSignal.timeout(5000),
      });
      await res.body?.cancel();
      expect(res.status, path).toBe(403);
    }
    const chunked = await rawStatuses(
      `POST /containers/${sandbox}/start HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n` +
        `Connection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,
    );
    expect(chunked).toEqual([403]);
  });

  it('refuses the actions with a query string', async () => {
    for (const path of [
      `/containers/${sandbox}/stop?t=0`,
      `/containers/${sandbox}/stop?signal=SIGKILL`,
      `/containers/${sandbox}/restart?t=0`,
      `/containers/${sandbox}/start?detachKeys=ctrl-x`,
      `/containers/${sandbox}/stop?`,
    ]) {
      expect(await status(path, 'POST'), path).toBe(403);
    }
  });

  it('refuses the actions under old API versions', async () => {
    for (const version of ['v1.0', 'v1.12', 'v1.24', 'v1.39', 'v1.4', 'v1.040', 'v2.0', 'v1.']) {
      const path = `/${version}/containers/${sandbox}/start`;
      expect(await status(path, 'POST'), path).toBe(403);
    }
  });

  it('refuses an action asking to upgrade the connection', async () => {
    const statuses = await rawStatuses(
      `POST /containers/${sandbox}/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`,
    );
    expect(statuses).toEqual([403]);
  });

  it('passes the allowed reads', async () => {
    for (const path of [
      '/_ping',
      '/version',
      '/containers/json?all=true',
      '/v1.47/containers/json',
      `/containers/${containerId}/json`,
      `/containers/${containerId}/stats?stream=false`,
      `/containers/${containerId}/logs?stdout=1&stderr=1&tail=1`,
      `/containers/${containerName}/logs?stdout=1&stderr=1&timestamps=1&tail=1`,
      `/v1.47/containers/${containerName}/logs?stdout=1&tail=1`,
      '/system/df?type=image&type=build-cache',
      '/v1.47/system/df?type=volume',
      `/volumes?filters=${encodeURIComponent('{"dangling":["true"]}')}`,
      '/volumes',
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

  it('streams logs (follow)', async () => {
    const controller = new AbortController();
    const res = await fetch(`${proxy.http}/containers/${containerName}/logs?stdout=1&follow=1`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort();
  });

  it('allows logs for reading only', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      expect(await status(`/containers/${containerId}/logs`, method), method).toBe(403);
    }
    // Neighbours of the logs path stay refused — attach would give the live input/output.
    for (const path of [
      `/containers/${containerId}/attach`,
      `/containers/${containerId}/attach/ws`,
      `/containers/${containerId}/logs/`,
      `/containers/${containerId}/logs/x`,
      `/containers/${containerId}/logsx`,
      '/containers/logs',
      `/containers/a/b/logs`,
      `/containers/.${containerName}/logs`,
      `/containers/${containerId}/LOGS`,
    ]) {
      expect(await status(path), path).toBe(403);
    }
    // A logs request asking to upgrade is still refused.
    const statuses = await rawStatuses(
      `GET /containers/${containerId}/logs HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`,
    );
    expect(statuses).toEqual([403]);
  });

  it('passes a volume delete to Docker, which refuses one in use and a missing one', async () => {
    expect(await status(`/volumes/${VOLUME_IN_USE}`, 'DELETE')).toBe(409);
    expect(await status('/volumes/laris-test-no-such-volume', 'DELETE')).toBe(404);
    expect(await status('/v1.40/volumes/laris-test-no-such-volume', 'DELETE')).toBe(404);
  });

  it('refuses a forced volume delete, a body, and every other delete', async () => {
    for (const path of [
      `/volumes/${VOLUME_IN_USE}?force=true`,
      `/volumes/${VOLUME_IN_USE}?force=1`,
      `/volumes/${VOLUME_IN_USE}?`,
      `/volumes/${VOLUME_IN_USE}/`,
      `/volumes/${VOLUME_IN_USE}/x`,
      `/volumes/.${VOLUME_IN_USE}`,
      `/volumes/a%2F..%2F${VOLUME_IN_USE}`,
      '/volumes/a',
      '/volumes',
      `/v1.39/volumes/${VOLUME_IN_USE}`,
      `/v1.4/volumes/${VOLUME_IN_USE}`,
      `/containers/${sandbox}`,
      '/images/debian:13',
      '/networks/bridge',
    ]) {
      expect(await status(path, 'DELETE'), `DELETE ${path}`).toBe(403);
    }
    expect(
      await rawStatuses(
        `DELETE /volumes/${VOLUME_IN_USE} HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      ),
    ).toEqual([403]);
    // The volume path for other methods: creating, inspecting one, …
    for (const method of ['GET', 'POST', 'PUT', 'HEAD']) {
      expect(await status(`/volumes/${VOLUME_IN_USE}`, method), method).toBe(403);
    }
  });

  it('refuses the prunes with any other query, a body, another method or an old API', async () => {
    // Never the allowed queries themselves: that would really delete images (see the top).
    for (const path of [
      '/images/prune',
      '/images/prune?',
      `/images/prune?filters=${encodeURIComponent('{"dangling":["true"]}')}`,
      `/images/prune?${IMAGE_PRUNE_QUERY}&x=1`,
      `/images/prune?x=1&${IMAGE_PRUNE_QUERY}`,
      `/images/prune?filters=${encodeURIComponent('{"dangling":["false"],"label":["x"]}')}`,
      `/images/prune?filters={"dangling":["false"]}`,
      `/images/prune/?${IMAGE_PRUNE_QUERY}`,
      `/v1.39/images/prune?${IMAGE_PRUNE_QUERY}`,
      '/build/prune',
      '/build/prune?all=1',
      '/build/prune?all=true&filters=x',
      '/build/prune?keep-storage=0&all=true',
      '/build/prune?all=TRUE',
      '/v1.39/build/prune?all=true',
      '/containers/prune',
      '/volumes/prune',
      '/networks/prune',
    ]) {
      expect(await status(path, 'POST'), `POST ${path}`).toBe(403);
    }
    for (const method of ['GET', 'PUT', 'DELETE']) {
      // Refused for the method alone, so these never reach Docker.
      expect(await status(`/images/prune?${IMAGE_PRUNE_QUERY}`, method), method).toBe(403);
      expect(await status('/build/prune?all=true', method), method).toBe(403);
    }
    for (const path of [`/images/prune?${IMAGE_PRUNE_QUERY}`, '/build/prune?all=true']) {
      const res = await fetch(`${proxy.http}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filters: { dangling: ['true'] } }),
        signal: AbortSignal.timeout(5000),
      });
      await res.body?.cancel();
      expect(res.status, path).toBe(403);
    }
  });

  it('refuses every other write', async () => {
    for (const [method, path] of [
      ['POST', '/containers/create'],
      ['POST', `/containers/${sandbox}/exec`],
      ['POST', `/containers/${sandbox}/kill`],
      ['POST', `/containers/${sandbox}/pause`],
      ['POST', `/containers/${sandbox}/unpause`],
      ['POST', `/containers/${sandbox}/update`],
      ['POST', `/containers/${sandbox}/rename?name=x`],
      ['POST', `/containers/${sandbox}/attach`],
      ['POST', `/containers/${sandbox}/wait`],
      ['POST', '/containers/prune'],
      ['DELETE', `/containers/${sandbox}`],
      ['POST', '/images/create'],
      ['POST', '/build'],
      ['PUT', `/containers/${sandbox}/archive?path=/tmp`],
      ['POST', '/v1.47/containers/create'],
    ]) {
      expect(await status(path, method), `${method} ${path}`).toBe(403);
    }
  });

  it('refuses reads that are not on the list', async () => {
    for (const path of [
      `/containers/${containerId}/export`,
      `/containers/${containerId}/archive?path=/etc`,
      `/containers/${containerId}/top`,
      `/containers/${containerId}/changes`,
      '/images/json',
      '/info',
      `/volumes/${VOLUME_IN_USE}`,
      '/volumes/',
      '/networks',
      '/secrets',
      '/system/df/',
      '/system/info',
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
