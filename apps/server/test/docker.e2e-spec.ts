import type { ConfigService } from '@nestjs/config';
import { containerSchema } from '@homelab/shared';
import type { Env } from '../src/config/env.schema.js';
import { DockerService } from '../src/docker/docker.service.js';
import { proxyReachable } from './docker-proxy.js';

// DockerService against real Docker, through the dev proxy (the app's only way in).

const reachable = await proxyReachable();

describe.skipIf(!reachable)('DockerService (e2e, real Docker through the proxy)', () => {
  const docker = new DockerService({
    get: () => process.env.DOCKER_HOST,
  } as unknown as ConfigService<Env, true>);

  it('lists the containers in the shared shape', async () => {
    const containers = await docker.listContainers();
    const postgres = containers.find((c) => c.name === 'homelab-dev-postgres-1');
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
});
