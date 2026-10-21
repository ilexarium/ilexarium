import type { ConfigService } from '@nestjs/config';
import { containerSchema, logLineSchema, type LogLine } from '@laris/shared';
import type { Env } from '../src/config/env.schema.js';
import { ContainerLogsError, DockerService } from '../src/docker/docker.service.js';
import { proxyReachable } from './docker-proxy.js';

// DockerService against real Docker, through the dev proxy (the app's only way in).

const reachable = await proxyReachable();

describe.skipIf(!reachable)('DockerService (e2e, real Docker through the proxy)', () => {
  const docker = new DockerService({
    get: () => process.env.DOCKER_HOST,
  } as unknown as ConfigService<Env, true>);

  it('lists the containers in the shared shape', async () => {
    const containers = await docker.listContainers();
    const postgres = containers.find((c) => c.name === 'laris-dev-postgres-1');
    expect(postgres).toMatchObject({ state: 'running', health: 'healthy' });
    expect(postgres!.startedAt).not.toBeNull();
    for (const container of containers) {
      expect(containerSchema.parse({ ...container, stats: null })).toEqual({
        ...container,
        stats: null,
      });
    }
  });

  it('streams stats of a running container, until aborted', async () => {
    const [running] = (await docker.listContainers()).filter((c) => c.state === 'running');
    const controller = new AbortController();
    const frames = [];
    for await (const stats of docker.containerStats(running.id, controller.signal)) {
      frames.push(stats);
      if (frames.length === 2) break;
    }
    controller.abort();
    expect(frames[1].memoryUsedBytes).toBeGreaterThan(0);
    expect(frames[1].memoryLimitBytes).toBeGreaterThan(0);
  });

  it('opens the events stream, and stops when aborted', async () => {
    const controller = new AbortController();
    const events = docker.containerEvents(controller.signal);
    const next = events.next();
    setTimeout(() => controller.abort(), 200);
    await expect(next).rejects.toThrow(); // aborted while waiting: no event in 200 ms
  });

  describe('logs of the dev Postgres', () => {
    const name = 'laris-dev-postgres-1';

    /** The first `count` lines, then aborts — and checks the stream really ends. */
    async function first(options: { tail?: number; since?: string }, count: number) {
      const controller = new AbortController();
      const logs = docker.containerLogs(name, options, controller.signal);
      const lines: LogLine[] = [];
      while (lines.length < count) {
        const next = await logs.next();
        if (next.done) break;
        lines.push(next.value);
      }
      controller.abort();
      // Aborted: the follow stream closes instead of waiting for more output.
      await expect(
        Promise.race([
          logs.next().then(
            () => 'ended',
            () => 'ended',
          ),
          new Promise((resolve) => setTimeout(() => resolve('still open'), 2000)),
        ]),
      ).resolves.toBe('ended');
      return lines;
    }

    it('reads the last lines in the shared shape, oldest first', async () => {
      const lines = await first({ tail: 3 }, 3);
      expect(lines).toHaveLength(3); // Postgres logs at least its startup
      for (const line of lines) expect(logLineSchema.parse(line)).toEqual(line);
      expect([...lines].sort((a, b) => a.at.localeCompare(b.at))).toEqual(lines);
    });

    it('resumes after a given line without repeating it', async () => {
      const lines = await first({ tail: 3 }, 3);
      const resumed = await first({ since: lines[1].at }, 1);
      expect(resumed[0]).toEqual(lines[2]);
    });

    it('reports an unknown container as not found', async () => {
      const logs = docker.containerLogs(
        'laris-no-such-container',
        {},
        new AbortController().signal,
      );
      await expect(logs.next()).rejects.toEqual(new ContainerLogsError('not_found'));
    });
  });
});
