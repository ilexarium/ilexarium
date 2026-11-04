import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { CleanupError, ContainerActionError, DockerControl } from './docker-control.js';

const IMAGE_PRUNE_QUERY = 'filters=%7B%22dangling%22%3A%5B%22false%22%5D%7D';

/**
 * Enough of the Docker Engine API for DockerControl: `web` is running, `app` is stopped, `broken`
 * fails; volume `music_cache` is unused, `pgdata` in use. Records every request with its body.
 */
class FakeDocker {
  readonly requests: { method: string; url: string; body: string }[] = [];
  readonly running = new Set(['web']);
  readonly volumes = new Set(['music_cache', 'pgdata']);
  pruneFails = false;
  private server!: Server;

  async listen(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `tcp://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      this.requests.push({ method: req.method!, url: req.url!, body });
      const json = (status: number, payload?: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(payload === undefined ? undefined : JSON.stringify(payload));
      };
      if (req.method === 'POST' && req.url === `/images/prune?${IMAGE_PRUNE_QUERY}`) {
        if (this.pruneFails) return json(500, { message: 'a prune operation is already running' });
        return json(200, {
          ImagesDeleted: [
            { Untagged: 'debian:13' },
            { Deleted: 'sha256:aaa' },
            { Deleted: 'sha256:bbb' },
          ],
          SpaceReclaimed: 3000,
        });
      }
      if (req.method === 'POST' && req.url === '/build/prune?all=true') {
        return json(200, { CachesDeleted: ['c1', 'c2'], SpaceReclaimed: 500 });
      }
      const volume = /^\/volumes\/([\w.-]+)$/.exec(req.url!);
      if (req.method === 'DELETE' && volume) {
        if (volume[1] === 'pgdata') return json(409, { message: 'volume is in use' });
        if (!this.volumes.delete(volume[1])) return json(404, { message: 'no such volume' });
        return json(204);
      }
      const match = /^\/containers\/(\w+)\/(start|stop|restart)$/.exec(req.url!);
      if (req.method !== 'POST' || !match) return json(404, { message: 'page not found' });
      const [, name, action] = match;
      if (name === 'broken') return json(500, { message: 'cannot stop container' });
      if (name !== 'web' && name !== 'app') return json(404, { message: 'No such container' });
      const running = this.running.has(name);
      if ((action === 'start' && running) || (action === 'stop' && !running)) return json(304);
      if (action === 'stop') this.running.delete(name);
      else this.running.add(name);
      json(204);
    });
  }
}

const configFor = (url: string) => ({ get: () => url }) as unknown as ConfigService<Env, true>;

describe('DockerControl', () => {
  let fake: FakeDocker;
  let control: DockerControl;

  beforeEach(async () => {
    fake = new FakeDocker();
    control = new DockerControl(configFor(await fake.listen()));
  });

  afterEach(() => fake.close());

  it('starts, stops and restarts by name: a bare POST, no query, no body', async () => {
    await control.stop('web');
    await control.start('web');
    await control.restart('app');
    expect(fake.requests).toEqual([
      { method: 'POST', url: '/containers/web/stop', body: '' },
      { method: 'POST', url: '/containers/web/start', body: '' },
      { method: 'POST', url: '/containers/app/restart', body: '' },
    ]);
    expect(fake.running).toEqual(new Set(['web', 'app']));
  });

  it('counts "already started/stopped" as done', async () => {
    await expect(control.start('web')).resolves.toBeUndefined();
    await expect(control.stop('app')).resolves.toBeUndefined();
  });

  it('tells an unknown container, a Docker error and an unreachable Docker apart', async () => {
    await expect(control.stop('nope')).rejects.toMatchObject({ reason: 'not_found' });
    await expect(control.stop('broken')).rejects.toMatchObject({ reason: 'failed' });
    await fake.close();
    const error = await control.start('web').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerActionError);
    expect(error).toMatchObject({ reason: 'unavailable' });
  });

  it('refuses a name that could leave the path, without asking Docker', async () => {
    for (const name of ['../json', 'a/../../b', 'web?signal=KILL', '']) {
      await expect(control.stop(name), name).rejects.toThrow(/Invalid container name/);
    }
    expect(fake.requests).toEqual([]);
  });

  it('removes unused images and the build cache: each with its one query, no body', async () => {
    await expect(control.pruneImages()).resolves.toEqual({
      bytesFreed: 3000,
      deleted: ['sha256:aaa', 'sha256:bbb'],
    });
    await expect(control.pruneBuildCache()).resolves.toEqual({
      bytesFreed: 500,
      deleted: ['c1', 'c2'],
    });
    expect(fake.requests).toEqual([
      { method: 'POST', url: `/images/prune?${IMAGE_PRUNE_QUERY}`, body: '' },
      { method: 'POST', url: '/build/prune?all=true', body: '' },
    ]);
  });

  it('tells a failed prune from an unreachable Docker', async () => {
    fake.pruneFails = true;
    await expect(control.pruneImages()).rejects.toMatchObject({ reason: 'failed' });
    await fake.close();
    const error = await control.pruneBuildCache().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CleanupError);
    expect(error).toMatchObject({ reason: 'unavailable' });
  });

  it('removes a volume by name, never forced', async () => {
    await control.removeVolume('music_cache');
    expect(fake.requests).toEqual([{ method: 'DELETE', url: '/volumes/music_cache', body: '' }]);
    expect(fake.volumes).toEqual(new Set(['pgdata']));
  });

  it('tells a volume in use, a missing one and an unreachable Docker apart', async () => {
    await expect(control.removeVolume('pgdata')).rejects.toMatchObject({ reason: 'in_use' });
    await expect(control.removeVolume('nope')).rejects.toMatchObject({ reason: 'not_found' });
    await fake.close();
    await expect(control.removeVolume('music_cache')).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('refuses a volume name that could leave the path, without asking Docker', async () => {
    for (const name of ['../images/json', 'a/b', 'x?force=true', '', 'a']) {
      await expect(control.removeVolume(name), name).rejects.toThrow(/Invalid volume name/);
    }
    expect(fake.requests).toEqual([]);
  });

  it('can do exactly six things', () => {
    const methods = Object.getOwnPropertyNames(DockerControl.prototype).filter(
      (name) => name !== 'constructor',
    );
    // `act` and `prune` are the private helpers.
    expect(methods.sort()).toEqual([
      'act',
      'prune',
      'pruneBuildCache',
      'pruneImages',
      'removeVolume',
      'restart',
      'start',
      'stop',
    ]);
  });
});
