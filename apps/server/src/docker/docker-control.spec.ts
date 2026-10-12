import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { ContainerActionError, DockerControl } from './docker-control.js';

/**
 * Enough of the Docker Engine API for DockerControl: `web` is running, `app` is stopped, `broken`
 * fails. Records every request with its body.
 */
class FakeDocker {
  readonly requests: { method: string; url: string; body: string }[] = [];
  readonly running = new Set(['web']);
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

  it('can do exactly three things', () => {
    const methods = Object.getOwnPropertyNames(DockerControl.prototype).filter(
      (name) => name !== 'constructor',
    );
    // `act` is the private helper the three share.
    expect(methods.sort()).toEqual(['act', 'restart', 'start', 'stop']);
  });
});
