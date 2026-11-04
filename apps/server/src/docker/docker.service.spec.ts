import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { ContainerLogsError, DockerService } from './docker.service.js';

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const ID_GONE = 'c'.repeat(64);

const summaries = [
  {
    Id: ID_B,
    Names: ['/web'],
    Image: 'nginx:1.27',
    State: 'running',
    Labels: { 'laris.protected': 'true', 'com.docker.compose.project': 'hl-web' },
    Ports: [
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
      { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
      { PrivatePort: 443, Type: 'tcp' },
    ],
  },
  {
    Id: ID_A,
    Names: ['/app'],
    Image: 'app:latest',
    State: 'exited',
    Labels: { 'laris.protected': 'yes' }, // only exactly "true" protects
    Ports: [],
  },
  { Id: ID_GONE, Names: ['/gone'], Image: 'x', State: 'running', Ports: [] },
];

const inspects: Record<string, object> = {
  [ID_B]: {
    Name: '/web',
    Config: { Tty: false, Labels: { 'laris.protected': 'true' } },
    State: {
      Status: 'running',
      StartedAt: '2026-10-11T12:00:00.123456789Z',
      Health: { Status: 'healthy' },
    },
  },
  [ID_A]: {
    Name: '/app',
    Config: { Tty: true, Labels: { 'laris.protected': 'yes' } },
    State: { Status: 'exited', StartedAt: '0001-01-01T00:00:00Z' },
  },
};
// Inspect and logs work by name too.
inspects.web = inspects[ID_B];
inspects.app = inspects[ID_A];
inspects.silent = { Name: '/silent', Config: { Tty: false }, State: {} };

const T1 = '2026-10-11T12:00:00.000000001Z';
const T2 = '2026-10-11T12:00:00.000000002Z';

/** A multiplexed log frame: 1 = stdout, 2 = stderr. */
function frame(type: number, text: string): Buffer {
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(Buffer.byteLength(text), 4);
  return Buffer.concat([header, Buffer.from(text)]);
}

const statsFrame = {
  read: '2026-10-11T16:03:29.374Z',
  cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 2 },
  precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
  memory_stats: { usage: 1000, stats: { inactive_file: 100 }, limit: 4000 },
};

const diskUsage = {
  Images: [
    {
      Id: `sha256:${'1'.repeat(64)}`,
      RepoTags: ['nginx:1.27'],
      Created: 1_790_000_000,
      Size: 200,
      SharedSize: 50,
      Containers: 1,
    },
    {
      Id: `sha256:${'2'.repeat(64)}`,
      RepoTags: ['debian:13', 'debian:latest'],
      Created: 1_790_000_000,
      Size: 300,
      SharedSize: 100,
      Containers: 0,
    },
    {
      Id: `sha256:${'3'.repeat(64)}`,
      RepoTags: ['<none>:<none>'],
      Size: 40,
      SharedSize: -1,
      Containers: 0,
    },
  ],
  ImageUsage: { Reclaimable: 330 },
  BuildCache: [
    { InUse: false, Shared: false, Size: 10 },
    { InUse: true, Shared: false, Size: 1000 },
  ],
  BuildCacheUsage: { Reclaimable: 15 },
};

const volumes = [
  {
    Name: 'navidrome_data',
    CreatedAt: '2026-10-11T19:59:33+02:00',
    Labels: { 'com.docker.compose.project': 'navidrome' },
  },
  { Name: 'f'.repeat(64), CreatedAt: 'not a date', Labels: { 'com.docker.volume.anonymous': '' } },
  { Name: 'cache', Labels: null },
];

/** Enough of the Docker Engine API for DockerService; records every request. */
class FakeDocker {
  readonly requests: { method: string; url: string }[] = [];
  /** Open streaming responses, to check that aborting really closes them. */
  readonly openStreams = new Set<ServerResponse>();
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
    this.requests.push({ method: req.method!, url: req.url! });
    const path = new URL(req.url!, 'http://docker').pathname;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    if (path === '/containers/json') return json(200, summaries);
    if (path === '/system/df') {
      const types = new URL(req.url!, 'http://docker').searchParams.getAll('type');
      if (types.join() === 'volume') {
        return json(200, {
          Volumes: [
            { Name: 'navidrome_data', UsageData: { RefCount: 0, Size: 2100 } },
            { Name: 'cache', UsageData: { RefCount: 0, Size: -1 } },
          ],
        });
      }
      return json(200, diskUsage);
    }
    if (path === '/volumes') return json(200, { Volumes: volumes, Warnings: null });
    const inspect = /^\/containers\/(\w+)\/json$/.exec(path);
    if (inspect) {
      const body = inspects[inspect[1]];
      return body ? json(200, body) : json(404, { message: 'No such container' });
    }
    const logs = /^\/containers\/(\w+)\/logs$/.exec(path);
    if (logs) {
      const name = logs[1];
      if (name === 'silent') {
        return json(501, { message: 'configured logging driver does not support reading' });
      }
      if (!inspects[name]) return json(404, { message: 'No such container' });
      res.writeHead(200, { 'Content-Type': 'application/vnd.docker.multiplexed-stream' });
      if (name === 'app') {
        // TTY, stopped: raw text, and Docker ends the stream after the history.
        res.end(`${T1} tty line\r\n${T2} \x1b[32mgreen\x1b[0m\r\n`);
        return;
      }
      this.openStreams.add(res);
      res.on('close', () => this.openStreams.delete(res));
      res.write(frame(1, `${T1} first\n`));
      res.write(frame(2, `${T2} second\n`));
      return; // running: follows, stays open
    }
    if (/^\/containers\/\w+\/stats$/.test(path) || path === '/events') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      this.openStreams.add(res);
      res.on('close', () => this.openStreams.delete(res));
      if (path === '/events') {
        res.write(
          JSON.stringify({
            Type: 'container',
            Action: 'start',
            Actor: {
              ID: ID_B,
              Attributes: {
                name: 'web',
                image: 'nginx',
                'com.docker.compose.project': 'hl-web',
                'laris.protected': 'true',
                SECRET_LOOKING_LABEL: 'kept out',
              },
            },
          }) + '\n',
        );
        res.write(JSON.stringify({ Type: 'container', Action: 'die', Actor: { ID: ID_A } }) + '\n');
      } else {
        // Split mid-object, like a real stream can be.
        const line = JSON.stringify(statsFrame) + '\n';
        res.write(line.slice(0, 20));
        res.write(line.slice(20) + line);
      }
      return; // stays open, like Docker's streams
    }
    json(404, { message: 'page not found' });
  }
}

const configFor = (url: string) => ({ get: () => url }) as unknown as ConfigService<Env, true>;

async function take<T>(iterator: AsyncGenerator<T>, count: number): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterator) {
    items.push(item);
    if (items.length === count) break;
  }
  return items;
}

describe('DockerService', () => {
  let fake: FakeDocker;
  let docker: DockerService;

  beforeEach(async () => {
    fake = new FakeDocker();
    docker = new DockerService(configFor(await fake.listen()));
  });

  afterEach(() => fake.close());

  it('names every container by full ID with one request, no inspect', async () => {
    const names = await docker.containerNames();
    expect(names.get(ID_B)).toEqual({ name: 'web', composeProject: 'hl-web' });
    expect(names.get(ID_GONE)).toEqual({ name: 'gone', composeProject: null });
    expect(fake.requests.map((r) => new URL(r.url, 'http://d').pathname)).toEqual([
      '/containers/json',
    ]);
  });

  it('lists every container in our shape, sorted by name', async () => {
    expect(await docker.listContainers()).toEqual([
      {
        id: ID_A,
        name: 'app',
        image: 'app:latest',
        state: 'exited',
        health: 'none',
        startedAt: null,
        ports: [],
        protected: false,
        composeProject: null,
        composeWorkingDir: null,
        template: null,
      },
      {
        id: ID_B,
        name: 'web',
        image: 'nginx:1.27',
        state: 'running',
        health: 'healthy',
        startedAt: '2026-10-11T12:00:00.123Z',
        ports: [
          { privatePort: 80, publicPort: 8080, ip: '0.0.0.0', protocol: 'tcp' },
          { privatePort: 443, protocol: 'tcp' },
        ],
        protected: true,
        composeProject: 'hl-web',
        composeWorkingDir: null,
        template: null,
      },
    ]);
    expect(fake.requests.map((r) => new URL(r.url, 'http://d').searchParams.get('all'))).toContain(
      'true',
    );
  });

  it('streams stats frames as our stats, until aborted — which closes the connection', async () => {
    const controller = new AbortController();
    const frames = await take(docker.containerStats(ID_B, controller.signal), 2);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      cpuPercent: 20,
      memoryUsedBytes: 900,
      memoryLimitBytes: 4000,
    });

    // Breaking out of the loop alone must not leave the response open forever: abort closes it.
    controller.abort();
    await vi.waitFor(() => expect(fake.openStreams.size).toBe(0));
  });

  it('streams container events with a container filter, until aborted', async () => {
    const controller = new AbortController();
    expect(await take(docker.containerEvents(controller.signal), 2)).toEqual([
      {
        containerId: ID_B,
        action: 'start',
        name: 'web',
        composeProject: 'hl-web',
        protected: true,
      },
      { containerId: ID_A, action: 'die', name: null, composeProject: null, protected: false },
    ]);
    const events = fake.requests.find((r) => r.url.startsWith('/events'))!;
    const filters = JSON.parse(new URL(events.url, 'http://d').searchParams.get('filters')!);
    expect(filters.type).toEqual(['container']);
    expect(filters.event).toContain('health_status');
    controller.abort();
    await vi.waitFor(() => expect(fake.openStreams.size).toBe(0));
  });

  it('streams a running container’s logs by name, following, until aborted', async () => {
    const controller = new AbortController();
    expect(await take(docker.containerLogs('web', { tail: 10 }, controller.signal), 2)).toEqual([
      { at: T1, stream: 'stdout', text: 'first' },
      { at: T2, stream: 'stderr', text: 'second' },
    ]);
    const request = fake.requests.find((r) => r.url.startsWith('/containers/web/logs'))!;
    const query = Object.fromEntries(new URL(request.url, 'http://d').searchParams);
    expect(query).toEqual({
      follow: 'true',
      stdout: 'true',
      stderr: 'true',
      timestamps: 'true',
      tail: '10',
    });
    controller.abort();
    await vi.waitFor(() => expect(fake.openStreams.size).toBe(0));
  });

  it('reads a TTY container’s raw logs, and ends when Docker ends the stream', async () => {
    const lines = [];
    for await (const line of docker.containerLogs('app', {}, new AbortController().signal)) {
      lines.push(line);
    }
    expect(lines).toEqual([
      { at: T1, stream: 'stdout', text: 'tty line' },
      { at: T2, stream: 'stdout', text: 'green' },
    ]);
    const request = fake.requests.find((r) => r.url.startsWith('/containers/app/logs'))!;
    expect(new URL(request.url, 'http://d').searchParams.has('tail')).toBe(false);
  });

  it('resumes with since: asks Docker in Unix seconds, and drops lines it already has', async () => {
    const controller = new AbortController();
    const since = '2026-10-11T12:00:00.000000001Z';
    expect(await take(docker.containerLogs('web', { since }, controller.signal), 1)).toEqual([
      { at: T2, stream: 'stderr', text: 'second' },
    ]);
    const request = fake.requests.find((r) => r.url.startsWith('/containers/web/logs'))!;
    expect(new URL(request.url, 'http://d').searchParams.get('since')).toBe('1791720000.000000001');
    controller.abort();
  });

  it('tells a container’s state by name, and null for an unknown one', async () => {
    expect(await docker.containerState('web')).toBe('running');
    expect(await docker.containerState('app')).toBe('exited');
    expect(await docker.containerState('nope')).toBeNull();
    await expect(docker.containerState('../json')).rejects.toThrow(/Invalid container name/);
  });

  it('tells whether a container is protected by name, and null for an unknown one', async () => {
    expect(await docker.isProtected('web')).toBe(true);
    expect(await docker.isProtected('app')).toBe(false); // only exactly "true" protects
    expect(await docker.isProtected('silent')).toBe(false); // no labels at all
    expect(await docker.isProtected('nope')).toBeNull();
    await expect(docker.isProtected('../json')).rejects.toThrow(/Invalid container name/);
  });

  it('tells an unknown container and an unreadable log driver apart', async () => {
    const signal = new AbortController().signal;
    await expect(take(docker.containerLogs('nope', {}, signal), 1)).rejects.toEqual(
      new ContainerLogsError('not_found'),
    );
    await expect(take(docker.containerLogs('silent', {}, signal), 1)).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('refuses an invalid name or since without asking Docker', async () => {
    const signal = new AbortController().signal;
    for (const name of ['../json', 'a/b', '', 'web?follow=0']) {
      await expect(take(docker.containerLogs(name, {}, signal), 1), name).rejects.toThrow(
        /Invalid container name/,
      );
    }
    await expect(take(docker.containerLogs('web', { since: 'x' }, signal), 1)).rejects.toThrow(
      /Invalid since/,
    );
    expect(fake.requests).toEqual([]);
  });

  it('rejects logs when Docker is not reachable', async () => {
    await fake.close();
    const logs = docker.containerLogs('web', {}, new AbortController().signal);
    await expect(take(logs, 1)).rejects.not.toBeInstanceOf(ContainerLogsError);
  });

  it('lists unused images and the build cache with what removing them frees', async () => {
    await expect(docker.diskUsage()).resolves.toEqual({
      images: [
        {
          id: '222222222222',
          tags: ['debian:13', 'debian:latest'],
          bytes: 300,
          created: new Date(1_790_000_000_000).toISOString(),
        },
        { id: '333333333333', tags: [], bytes: 40, created: null },
      ],
      imagesBytes: 330,
      buildCacheBytes: 15,
    });
    expect(fake.requests.at(-1)?.url).toBe('/system/df?type=image&type=build-cache');
  });

  it('works out what can be freed when an older Docker leaves the sums out', async () => {
    const { ImageUsage, BuildCacheUsage } = diskUsage;
    Object.assign(diskUsage, { ImageUsage: undefined, BuildCacheUsage: undefined });
    try {
      const usage = await docker.diskUsage();
      expect(usage.imagesBytes).toBe(200 + 40); // shared layers left out
      expect(usage.buildCacheBytes).toBe(10); // what's in use stays
    } finally {
      Object.assign(diskUsage, { ImageUsage, BuildCacheUsage });
    }
  });

  it('lists volumes no container uses, by name, with their app', async () => {
    await expect(docker.unusedVolumes()).resolves.toEqual([
      { name: 'cache', composeProject: null, anonymous: false, created: null },
      { name: 'f'.repeat(64), composeProject: null, anonymous: true, created: null },
      {
        name: 'navidrome_data',
        composeProject: 'navidrome',
        anonymous: false,
        created: '2026-10-11T17:59:33.000Z',
      },
    ]);
    expect(fake.requests.at(-1)?.url).toBe(
      `/volumes?filters=${encodeURIComponent('{"dangling":["true"]}')}`,
    );
  });

  it('reads volume sizes separately; null where Docker didn’t count', async () => {
    const sizes = await docker.volumeSizes();
    expect(sizes).toEqual(
      new Map([
        ['navidrome_data', 2100],
        ['cache', null],
      ]),
    );
    expect(fake.requests.at(-1)?.url).toBe('/system/df?type=volume');
  });

  it('names the Compose projects of the platform’s own containers', async () => {
    await expect(docker.protectedProjects()).resolves.toEqual(new Set(['hl-web']));
  });

  it('only ever reads: every request is a GET', async () => {
    const controller = new AbortController();
    await docker.listContainers();
    await take(docker.containerStats(ID_B, controller.signal), 1);
    await take(docker.containerEvents(controller.signal), 1);
    await take(docker.containerLogs('web', {}, controller.signal), 1);
    await docker.diskUsage();
    await docker.unusedVolumes();
    await docker.volumeSizes();
    controller.abort();
    expect(fake.requests.length).toBeGreaterThan(3);
    expect(new Set(fake.requests.map((r) => r.method))).toEqual(new Set(['GET']));
  });

  it('rejects when Docker is not reachable', async () => {
    await fake.close();
    await expect(docker.listContainers()).rejects.toThrow();
  });

  it('offers no method that changes anything', () => {
    const methods = Object.getOwnPropertyNames(DockerService.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methods.sort()).toEqual([
      'appFolders',
      'bindMounts',
      'containerEvents',
      'containerLogs',
      'containerNames',
      'containerState',
      'containerStats',
      'diskUsage',
      'isProtected',
      'listContainers',
      'protectedProjects',
      'unusedVolumes',
      'volumeSizes',
    ]);
  });
});
