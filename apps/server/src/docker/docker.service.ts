import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CONTAINER_HEALTH,
  CONTAINER_STATES,
  type ContainerHealth,
  type ContainerPort,
  type ContainerState,
  type ContainerStats,
  containerNameSchema,
  type LogLine,
  PROTECTED_LABEL,
  TEMPLATE_LABEL,
} from '@ilex/shared';
import Dockerode from 'dockerode';
import type { Env } from '../config/env.schema.js';
import { toContainerStats } from './container-stats.js';
import { createDockerClient, dockerRequest } from './docker-client.js';
import {
  ANONYMOUS_VOLUME_LABEL,
  DISK_USAGE_TIMEOUT_MS,
  VOLUME_SIZES_TIMEOUT_MS,
} from './docker.constants.js';
import { jsonLines } from './json-lines.js';
import { logLines, normaliseTimestamp, toUnixSeconds } from './log-lines.js';
import type {
  DockerContainer,
  DockerContainerEvent,
  DockerDiskUsage,
  DockerVolume,
  RawContainerStats,
  RawDiskUsage,
} from './docker.model.js';

/** Why a container's logs can't be read: no such container, or a log driver Docker can't read back. */
export class ContainerLogsError extends Error {
  constructor(readonly reason: 'not_found' | 'unavailable') {
    super(`Container logs ${reason}`);
    this.name = 'ContainerLogsError';
  }
}

/** Requests that answer at once; streams have no timeout (they end with their abort signal). */
const REQUEST_TIMEOUT_MS = 5_000;
/** Set by Compose on every container it creates: the project's name. */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
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
 * Reading from Docker, and **read-only by construction**: list, inspect, stats, events, logs and
 * disk usage — there is no method that changes anything (that's `DockerControl`'s). Docker access
 * is root-equivalent (see CLAUDE.md);
 * the socket proxy enforces the same allow-list at the network level. Only `src/docker/` may
 * import `dockerode` (lint rule). Returns our own types, never Dockerode's.
 */
@Injectable()
export class DockerService {
  private readonly docker: Dockerode;

  constructor(config: ConfigService<Env, true>) {
    this.docker = createDockerClient(config);
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
            protected: summary.Labels?.[PROTECTED_LABEL] === 'true',
            composeProject: summary.Labels?.[COMPOSE_PROJECT_LABEL] ?? null,
            composeWorkingDir: summary.Labels?.[COMPOSE_WORKING_DIR_LABEL] ?? null,
            template: summary.Labels?.[TEMPLATE_LABEL] ?? null,
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

  /**
   * Every container's name and Compose project, by full ID — one request, no inspect (the
   * process list names the containers processes run in).
   */
  async containerNames(): Promise<Map<string, { name: string; composeProject: string | null }>> {
    const summaries = await this.docker.listContainers({
      all: true,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return new Map(
      summaries.map((summary) => [
        summary.Id,
        {
          name: (summary.Names[0] ?? summary.Id.slice(0, 12)).replace(/^\//, ''),
          composeProject: summary.Labels?.[COMPOSE_PROJECT_LABEL] ?? null,
        },
      ]),
    );
  }

  /**
   * Each Compose project's folders: its working directory and the host folders its containers
   * mount (bind mounts), those inside another left out — one request, no inspect.
   */
  async appFolders(): Promise<Map<string, string[]>> {
    const summaries = await this.docker.listContainers({
      all: true,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const folders = new Map<string, Set<string>>();
    for (const summary of summaries) {
      const project = summary.Labels?.[COMPOSE_PROJECT_LABEL];
      if (!project || summary.Labels?.[PROTECTED_LABEL] === 'true') continue;
      const own = folders.get(project) ?? new Set<string>();
      const workingDir = summary.Labels?.[COMPOSE_WORKING_DIR_LABEL];
      if (workingDir?.startsWith('/')) own.add(workingDir);
      for (const mount of summary.Mounts ?? []) {
        if (mount.Type === 'bind' && mount.Source?.startsWith('/')) own.add(mount.Source);
      }
      folders.set(project, own);
    }
    // A mount inside the app's own folder is backed up with it.
    const top = (own: Set<string>) =>
      [...own].filter((a) => ![...own].some((b) => b !== a && a.startsWith(`${b}/`))).sort();
    return new Map([...folders].map(([project, own]) => [project, top(own)]));
  }

  /** A container's bind-mounted host folders (where it keeps its data); empty when it's gone. */
  async bindMounts(name: string): Promise<string[]> {
    try {
      const details = await this.docker
        .getContainer(name)
        .inspect({ abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return (details.Mounts ?? [])
        .filter((mount) => mount.Type === 'bind' && mount.Source?.startsWith('/'))
        .map((mount) => mount.Source);
    } catch {
      return [];
    }
  }

  /** The Compose projects of the platform's own containers (`ilex.protected`). */
  async protectedProjects(): Promise<Set<string>> {
    const summaries = await this.docker.listContainers({
      all: true,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return new Set(
      summaries
        .filter((summary) => summary.Labels?.[PROTECTED_LABEL] === 'true')
        .map((summary) => summary.Labels?.[COMPOSE_PROJECT_LABEL])
        .filter((project) => project !== undefined),
    );
  }

  /**
   * Images no container uses (a stopped one counts as using it) and the build cache, with what
   * removing them frees. Asks only for those two (`type` needs API 1.42; an older Docker answers
   * with everything, just slower).
   */
  async diskUsage(): Promise<DockerDiskUsage> {
    const usage = await dockerRequest<RawDiskUsage>(this.docker, {
      method: 'GET',
      path: '/system/df',
      query: { type: ['image', 'build-cache'] },
      statusCodes: { 200: true, 500: 'server error' },
      abortSignal: AbortSignal.timeout(DISK_USAGE_TIMEOUT_MS),
    });
    const unused = (usage.Images ?? []).filter((image) => image.Containers === 0);
    const cache = usage.BuildCache ?? [];
    return {
      images: unused.map((image) => ({
        id: image.Id.replace(/^sha256:/, '').slice(0, 12),
        tags: (image.RepoTags ?? []).filter((tag) => tag !== '<none>:<none>'),
        bytes: Math.max(0, image.Size ?? 0),
        created: image.Created ? new Date(image.Created * 1000).toISOString() : null,
      })),
      // Docker's own sum counts layers shared between unused images once; older APIs lack it.
      imagesBytes:
        usage.ImageUsage?.Reclaimable ??
        unused.reduce(
          (sum, image) => sum + Math.max(0, (image.Size ?? 0) - Math.max(0, image.SharedSize ?? 0)),
          0,
        ),
      buildCacheBytes:
        usage.BuildCacheUsage?.Reclaimable ??
        cache
          .filter((record) => !record.InUse && !record.Shared)
          .reduce((sum, record) => sum + Math.max(0, record.Size ?? 0), 0),
    };
  }

  /** Volumes no container uses (Docker's `dangling`), sorted by name. No sizes: `volumeSizes()`. */
  async unusedVolumes(): Promise<DockerVolume[]> {
    const { Volumes } = await this.docker.listVolumes({
      filters: { dangling: ['true'] },
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    } as Dockerode.VolumeListOptions);
    return (Volumes ?? [])
      .map((volume) => {
        // Docker sends it; the types don't know it.
        const createdAt = (volume as { CreatedAt?: string }).CreatedAt;
        const created = createdAt ? new Date(createdAt) : null;
        return {
          name: volume.Name,
          composeProject: volume.Labels?.[COMPOSE_PROJECT_LABEL] ?? null,
          anonymous: volume.Labels?.[ANONYMOUS_VOLUME_LABEL] !== undefined,
          created: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every volume's size by name; null where Docker didn't count it. Slow: Docker walks them all. */
  async volumeSizes(): Promise<Map<string, number | null>> {
    const usage = await dockerRequest<RawDiskUsage>(this.docker, {
      method: 'GET',
      path: '/system/df',
      query: { type: ['volume'] },
      statusCodes: { 200: true, 500: 'server error' },
      abortSignal: AbortSignal.timeout(VOLUME_SIZES_TIMEOUT_MS),
    });
    return new Map(
      (usage.Volumes ?? []).map((volume) => {
        const size = volume.UsageData?.Size;
        return [volume.Name, size !== undefined && size >= 0 ? size : null];
      }),
    );
  }

  /** Live stats of a running container, about one per second, until `signal` aborts. */
  async *containerStats(id: string, signal: AbortSignal): AsyncGenerator<ContainerStats> {
    const stream = await this.docker
      .getContainer(id)
      .stats({ stream: true, abortSignal: signal } as { stream: true });
    for await (const frame of jsonLines(stream)) {
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
   * Whether a container is labelled `ilex.protected=true` (can't be stopped or restarted),
   * by name; null if there is no such container.
   */
  async isProtected(name: string): Promise<boolean | null> {
    if (!containerNameSchema.safeParse(name).success) throw new Error('Invalid container name');
    try {
      const details = await this.docker
        .getContainer(name)
        .inspect({ abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return details.Config.Labels?.[PROTECTED_LABEL] === 'true';
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
    let body: AsyncIterable<Buffer | string>;
    let tty: boolean;
    try {
      const details = await container.inspect({
        abortSignal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      tty = details.Config.Tty;
      body = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: true,
        ...(tail !== undefined && { tail }),
        ...(after && { since: toUnixSeconds(after) }),
        abortSignal: signal,
      });
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
    for await (const event of jsonLines(stream)) {
      const { Action, Actor } = event as {
        Action?: string;
        Actor?: { ID?: string; Attributes?: Record<string, string> };
      };
      if (!Action || !Actor?.ID) continue;
      const attributes = Actor.Attributes ?? {};
      yield {
        containerId: Actor.ID,
        action: Action,
        name: attributes.name?.replace(/^\//, '') || null,
        composeProject: attributes[COMPOSE_PROJECT_LABEL] ?? null,
        protected: attributes[PROTECTED_LABEL] === 'true',
      };
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
