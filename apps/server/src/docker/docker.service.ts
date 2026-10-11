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
  containerNameSchema,
  type LogLine,
} from '@homelab/shared';
import Dockerode from 'dockerode';
import type { Env } from '../config/env.schema.js';
import { type RawContainerStats, toContainerStats } from './container-stats.js';
import { jsonLines } from './json-lines.js';
import { logLines, normaliseTimestamp, toUnixSeconds } from './log-lines.js';

/** A container without its live stats. */
export type DockerContainer = Omit<Container, 'stats'>;

/** A container event: something about it changed (started, died, became healthy, …). */
export interface DockerContainerEvent {
  containerId: string;
  action: string;
}

/** Why a container's logs can't be read: no such container, or a log driver Docker can't read back. */
export class ContainerLogsError extends Error {
  constructor(readonly reason: 'not_found' | 'unavailable') {
    super(`Container logs ${reason}`);
    this.name = 'ContainerLogsError';
  }
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
 * The only way into Docker, and **read-only by construction**: list, inspect, stats, events and logs —
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

  /**
   * Every container (running or not), sorted by name. Rejects when Docker is not reachable.
   * Inspect also returns each container's environment — often its secrets: only the fields
   * below are kept, and environment values must never be passed on (to the browser or logs).
   */
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

  /** A container's state, by name; null if there is no such container. */
  async containerState(name: string): Promise<ContainerState | null> {
    if (!containerNameSchema.safeParse(name).success) throw new Error('Invalid container name');
    try {
      const details = await this.docker
        .getContainer(name)
        .inspect({ abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return toState(details.State.Status);
    } catch (error) {
      if ((error as { statusCode?: number } | null)?.statusCode === 404) return null;
      throw error;
    }
  }

  /**
   * A container's logs, by name: the last `tail` lines (all if left out) or only those after
   * `since`, then new lines live — until the container stops (Docker ends the stream, and so does
   * this) or `signal` aborts. Throws `ContainerLogsError` for an unknown container or a log driver
   * that can't be read back; other errors (Docker not reachable) as they are.
   */
  async *containerLogs(
    name: string,
    { tail, since }: { tail?: number; since?: string },
    signal: AbortSignal,
  ): AsyncGenerator<LogLine> {
    // Callers validate it already; it goes into a URL path, so check again here.
    if (!containerNameSchema.safeParse(name).success) throw new Error('Invalid container name');
    const after = since === undefined ? null : normaliseTimestamp(since);
    if (since !== undefined && !after) throw new Error('Invalid since timestamp');

    const container = this.docker.getContainer(name);
    let body: AsyncIterable<Buffer>;
    let tty: boolean;
    try {
      const details = await container.inspect({
        abortSignal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      tty = details.Config.Tty;
      body = (await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: true,
        ...(tail !== undefined && { tail }),
        ...(after && { since: toUnixSeconds(after) }),
        abortSignal: signal,
      })) as AsyncIterable<Buffer>;
    } catch (error) {
      throw toLogsError(error);
    }
    for await (const line of logLines(body, { tty })) {
      // Docker's `since` includes lines at that very time: the viewer has those already.
      if (after && line.at <= after) continue;
      yield line;
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

function toLogsError(error: unknown): unknown {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  if (status === 404) return new ContainerLogsError('not_found');
  if (status === 501) return new ContainerLogsError('unavailable'); // e.g. log driver `none`
  return error;
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
