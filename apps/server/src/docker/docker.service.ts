import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CONTAINER_HEALTH,
  CONTAINER_STATES,
  type Container,
  type ContainerHealth,
  type ContainerPort,
  type ContainerState,
  type ContainerStats,
} from '@homelab/shared';
import Dockerode from 'dockerode';
import type { Env } from '../config/env.schema.js';
import { type RawContainerStats, toContainerStats } from './container-stats.js';
import { jsonLines } from './json-lines.js';

/** A container without its live stats. */
export type DockerContainer = Omit<Container, 'stats'>;

/** A container event: something about it changed (started, died, became healthy, …). */
export interface DockerContainerEvent {
  containerId: string;
  action: string;
}

/** Requests that answer at once; streams have no timeout (they end with their abort signal). */
const REQUEST_TIMEOUT_MS = 5_000;
/** Docker's zero time: a container that never started. */
const NEVER = '0001-01-01T00:00:00Z';
/** The events that can change what the containers table shows. */
const CONTAINER_EVENTS = [
  'create',
  'start',
  'restart',
  'stop',
  'die',
  'kill',
  'pause',
  'unpause',
  'destroy',
  'rename',
  'oom',
  'health_status',
];

/**
 * The only way into Docker, and **read-only by construction**: list, inspect, stats and events —
 * there is no method that changes anything. Docker access is root-equivalent (see CLAUDE.md);
 * the socket proxy enforces the same allow-list at the network level. Only `src/docker/` may
 * import `dockerode` (lint rule). Returns our own types, never Dockerode's.
 */
@Injectable()
export class DockerService {
  private readonly docker: Dockerode;

  constructor(config: ConfigService<Env, true>) {
    const url = new URL(config.get('DOCKER_HOST', { infer: true }));
    this.docker = new Dockerode({
      protocol: 'http',
      host: url.hostname.replace(/^\[(.*)\]$/, '$1'), // IPv6 literal without brackets
      port: Number(url.port || 2375),
    });
  }

  /** Every container (running or not), sorted by name. Rejects when Docker is not reachable. */
  async listContainers(): Promise<DockerContainer[]> {
    const summaries = await this.docker.listContainers({
      all: true,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const containers = await Promise.all(
      summaries.map(async (summary): Promise<DockerContainer | null> => {
        try {
          const details = await this.docker
            .getContainer(summary.Id)
            .inspect({ abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
          const startedAt = details.State.StartedAt;
          return {
            id: summary.Id,
            name: (summary.Names[0] ?? details.Name).replace(/^\//, ''),
            image: summary.Image,
            state: toState(summary.State),
            health: toHealth(details.State.Health?.Status),
            startedAt: startedAt && startedAt !== NEVER ? new Date(startedAt).toISOString() : null,
            ports: toPorts(summary.Ports),
          };
        } catch {
          return null; // removed between the list and the inspect
        }
      }),
    );
    return containers
      .filter((container) => container !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Live stats of a running container, about one per second, until `signal` aborts. */
  async *containerStats(id: string, signal: AbortSignal): AsyncGenerator<ContainerStats> {
    const stream = await this.docker
      .getContainer(id)
      .stats({ stream: true, abortSignal: signal } as { stream: true });
    for await (const frame of jsonLines(stream as AsyncIterable<Buffer>)) {
      yield toContainerStats(frame as RawContainerStats, Date.now());
    }
  }

  /** Container events until `signal` aborts. */
  async *containerEvents(signal: AbortSignal): AsyncGenerator<DockerContainerEvent> {
    const stream = await this.docker.getEvents({
      filters: { type: ['container'], event: CONTAINER_EVENTS },
      abortSignal: signal,
    } as Dockerode.GetEventsOptions);
    for await (const event of jsonLines(stream as AsyncIterable<Buffer>)) {
      const { Action, Actor } = event as { Action?: string; Actor?: { ID?: string } };
      if (Action && Actor?.ID) yield { containerId: Actor.ID, action: Action };
    }
  }
}

function toState(state: string): ContainerState {
  return (CONTAINER_STATES as readonly string[]).includes(state)
    ? (state as ContainerState)
    : 'dead';
}

function toHealth(status: string | undefined): ContainerHealth {
  return status && (CONTAINER_HEALTH as readonly string[]).includes(status)
    ? (status as ContainerHealth)
    : 'none';
}

/** Docker lists a published port once per address family (0.0.0.0 and ::); shown once. */
function toPorts(ports: Dockerode.Port[]): ContainerPort[] {
  const seen = new Set<string>();
  const result: ContainerPort[] = [];
  for (const port of ports) {
    const protocol = port.Type === 'udp' || port.Type === 'sctp' ? port.Type : 'tcp';
    const key = `${port.PrivatePort}/${port.PublicPort ?? ''}/${protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      privatePort: port.PrivatePort,
      ...(port.PublicPort && { publicPort: port.PublicPort }),
      ...(port.IP && { ip: port.IP }),
      protocol,
    });
  }
  return result.sort((a, b) => a.privatePort - b.privatePort);
}
