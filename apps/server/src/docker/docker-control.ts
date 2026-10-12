import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { containerNameSchema } from '@homelab/shared';
import type Dockerode from 'dockerode';
import type { Env } from '../config/env.schema.js';
import { createDockerClient } from './docker-client.js';
import type { ContainerActionFailure } from './docker.model.js';

/**
 * Stop and restart wait for the container's grace period (10 s unless it sets its own), then
 * Docker kills it. Generous, so a slow but normal stop isn't reported as a failure.
 */
const ACTION_TIMEOUT_MS = 120_000;

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

/**
 * Changing Docker: **exactly** start, stop and restart a container, by name — nothing else (a
 * test pins it). The socket proxy allows the same three requests and refuses every other write.
 * Callers check protection and audit first (`ContainerActionsService`); this only acts.
 * Answers when Docker is done; "already started/stopped" counts as done.
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
