import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { DockerService } from './docker.service.js';

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const ID_GONE = 'c'.repeat(64);

const summaries = [
  {
    Id: ID_B,
    Names: ['/web'],
    Image: 'nginx:1.27',
    State: 'running',
    Ports: [
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
      { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
      { PrivatePort: 443, Type: 'tcp' },
    ],
  },
  { Id: ID_A, Names: ['/app'], Image: 'app:latest', State: 'exited', Ports: [] },
  { Id: ID_GONE, Names: ['/gone'], Image: 'x', State: 'running', Ports: [] },
];

const inspects: Record<string, object> = {
  [ID_B]: {
    Name: '/web',
    State: { StartedAt: '2026-10-11T12:00:00.123456789Z', Health: { Status: 'healthy' } },
  },
  [ID_A]: { Name: '/app', State: { StartedAt: '0001-01-01T00:00:00Z' } },
};

const statsFrame = {
  read: '2026-10-11T16:03:29.374Z',
  cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 2 },
  precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
  memory_stats: { usage: 1000, stats: { inactive_file: 100 }, limit: 4000 },
};

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
    const inspect = /^\/containers\/(\w+)\/json$/.exec(path);
    if (inspect) {
      const body = inspects[inspect[1]];
      return body ? json(200, body) : json(404, { message: 'No such container' });
    }
    if (/^\/containers\/\w+\/stats$/.test(path) || path === '/events') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      this.openStreams.add(res);
      res.on('close', () => this.openStreams.delete(res));
      if (path === '/events') {
        res.write(
          JSON.stringify({ Type: 'container', Action: 'start', Actor: { ID: ID_B } }) + '\n',
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
      { containerId: ID_B, action: 'start' },
      { containerId: ID_A, action: 'die' },
    ]);
    const events = fake.requests.find((r) => r.url.startsWith('/events'))!;
    const filters = JSON.parse(new URL(events.url, 'http://d').searchParams.get('filters')!);
    expect(filters.type).toEqual(['container']);
    expect(filters.event).toContain('health_status');
    controller.abort();
    await vi.waitFor(() => expect(fake.openStreams.size).toBe(0));
  });

  it('only ever reads: every request is a GET', async () => {
    const controller = new AbortController();
    await docker.listContainers();
    await take(docker.containerStats(ID_B, controller.signal), 1);
    await take(docker.containerEvents(controller.signal), 1);
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
    expect(methods.sort()).toEqual(['containerEvents', 'containerStats', 'listContainers']);
  });
});
