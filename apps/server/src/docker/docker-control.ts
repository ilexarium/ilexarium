import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { containerNameSchema, volumeNameSchema } from '@laris/shared';
import type Dockerode from 'dockerode';
import type { Env } from '../config/env.schema.js';
import { ACTION_TIMEOUT_MS, PRUNE_TIMEOUT_MS } from './docker-control.constants.js';
import { createDockerClient, dockerRequest } from './docker-client.js';
import type { CleanupFailure, ContainerActionFailure, DockerPruned } from './docker.model.js';

/** Why a container action didn't happen (or may not have). */
export class ContainerActionError extends Error {
  constructor(
    readonly reason: ContainerActionFailure,
    options?: ErrorOptions,
  ) {
    super(`Container action ${reason}`, options);
    this.name = 'ContainerActionError';
  }
}

/** Why freeing space didn't happen (or may not have). */
export class CleanupError extends Error {
  constructor(
    readonly reason: CleanupFailure,
    options?: ErrorOptions,
  ) {
    super(`Docker cleanup ${reason}`, options);
    this.name = 'CleanupError';
  }
}

/**
 * **Exactly** start, stop and restart a container, remove unused images, empty the build cache and
 * remove one volume — nothing else (a test pins it); the socket proxy allows the same requests.
 * Callers check and audit first (`ContainerActionsService`, `DockerCleanupService`).
 * "Already started/stopped" (304) counts as done.
 */
@Injectable()
export class DockerControl {
  private readonly docker: Dockerode;

  constructor(config: ConfigService<Env, true>) {
    this.docker = createDockerClient(config);
  }

  start(name: string): Promise<void> {
    return this.act(name, (container, abortSignal) => container.start({ abortSignal }));
  }

  stop(name: string): Promise<void> {
    return this.act(name, (container, abortSignal) => container.stop({ abortSignal }));
  }

  restart(name: string): Promise<void> {
    return this.act(name, (container, abortSignal) => container.restart({ abortSignal }));
  }

  /** Every image no container uses — a stopped container keeps its image. */
  async pruneImages(): Promise<DockerPruned> {
    const answer = await this.prune<{
      ImagesDeleted?: { Deleted?: string }[] | null;
      SpaceReclaimed?: number;
    }>('/images/prune', { filters: { dangling: ['false'] } });
    return {
      bytesFreed: answer.SpaceReclaimed ?? 0,
      deleted: (answer.ImagesDeleted ?? []).flatMap((entry) => entry.Deleted ?? []),
    };
  }

  /** The whole build cache, not only what's dangling. */
  async pruneBuildCache(): Promise<DockerPruned> {
    const answer = await this.prune<{ CachesDeleted?: string[] | null; SpaceReclaimed?: number }>(
      '/build/prune',
      { all: true },
    );
    return { bytesFreed: answer.SpaceReclaimed ?? 0, deleted: answer.CachesDeleted ?? [] };
  }

  /** Never forced: Docker itself refuses (409) a volume a container uses. */
  async removeVolume(name: string): Promise<void> {
    // Callers validate it already; it goes into a URL path, so check again here.
    if (!volumeNameSchema.safeParse(name).success) throw new Error('Invalid volume name');
    try {
      await this.docker
        .getVolume(name)
        .remove({ abortSignal: AbortSignal.timeout(ACTION_TIMEOUT_MS) });
    } catch (error) {
      const status = (error as { statusCode?: number } | null)?.statusCode;
      if (status === 404) throw new CleanupError('not_found', { cause: error });
      if (status === 409) throw new CleanupError('in_use', { cause: error });
      throw new CleanupError(status ? 'failed' : 'unavailable', { cause: error });
    }
  }

  /** The one query the proxy allows for each prune, no body. */
  private async prune<T>(path: string, query: Record<string, unknown>): Promise<T> {
    try {
      return await dockerRequest<T>(this.docker, {
        method: 'POST',
        path,
        query,
        statusCodes: { 200: true, 409: 'conflict', 500: 'server error' },
        abortSignal: AbortSignal.timeout(PRUNE_TIMEOUT_MS),
      });
    } catch (error) {
      const status = (error as { statusCode?: number } | null)?.statusCode;
      throw new CleanupError(status ? 'failed' : 'unavailable', { cause: error });
    }
  }

  /** Only the abort signal goes in: no query parameters, no body (the proxy refuses both). */
  private async act(
    name: string,
    request: (container: Dockerode.Container, abortSignal: AbortSignal) => Promise<unknown>,
  ): Promise<void> {
    // Callers validate it already; it goes into a URL path, so check again here.
    if (!containerNameSchema.safeParse(name).success) throw new Error('Invalid container name');
    try {
      await request(this.docker.getContainer(name), AbortSignal.timeout(ACTION_TIMEOUT_MS));
    } catch (error) {
      const status = (error as { statusCode?: number } | null)?.statusCode;
      if (status === 304) return; // already started / stopped
      if (status === 404) throw new ContainerActionError('not_found', { cause: error });
      // Docker (or the proxy) answered with an error; otherwise it couldn't be reached in time.
      throw new ContainerActionError(status ? 'failed' : 'unavailable', { cause: error });
    }
  }
}
