import { HttpException, Injectable } from '@nestjs/common';
import {
  type ApiErrorResponse,
  DOCKER_CLEANUP_ERROR_CODES,
  type DockerCleanup,
  type DockerCleanupErrorCode,
  type DockerPruneResult,
  type VolumeSizes,
} from '@laris/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuditEntry } from '../audit/audit.model.js';
import { CleanupError, DockerControl } from '../docker/docker-control.js';
import { DockerService } from '../docker/docker.service.js';
import type { DockerVolume } from '../docker/docker.model.js';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import { ERRORS, FAILURE_CODES } from './docker-cleanup.constants.js';
import type { CleanupActor } from './docker-cleanup.model.js';

function refusal(code: DockerCleanupErrorCode): HttpException {
  const [status, message] = ERRORS[code];
  const body: ApiErrorResponse = { message, code };
  return new HttpException(body, status);
}

const codeOf = (failure: unknown): DockerCleanupErrorCode =>
  failure instanceof CleanupError
    ? FAILURE_CODES[failure.reason]
    : DOCKER_CLEANUP_ERROR_CODES.failed;

/**
 * What Docker keeps that nothing uses, and freeing it (docs/plans/docker_cleanup.md). Every change
 * follows the privileged order: check (nothing changing apps right now; never the platform's own
 * volumes), **record the request — or don't act**, act, record the outcome.
 */
@Injectable()
export class DockerCleanupService {
  constructor(
    private readonly dockerService: DockerService,
    private readonly dockerControl: DockerControl,
    private readonly auditService: AuditService,
    private readonly changesUnderway: ChangesUnderway,
  ) {}

  async overview(): Promise<DockerCleanup> {
    try {
      const [usage, volumes] = await Promise.all([
        this.dockerService.diskUsage(),
        this.ownVolumesLeftOut(),
      ]);
      return {
        images: usage.images,
        imagesBytes: usage.imagesBytes,
        buildCacheBytes: usage.buildCacheBytes,
        volumes: volumes.map(({ name, composeProject, anonymous, created }) => ({
          name,
          app: composeProject,
          anonymous,
          created,
        })),
      };
    } catch {
      throw refusal(DOCKER_CLEANUP_ERROR_CODES.dockerUnavailable);
    }
  }

  /** Only of the volumes the overview lists. */
  async volumeSizes(): Promise<VolumeSizes> {
    try {
      const [sizes, volumes] = await Promise.all([
        this.dockerService.volumeSizes(),
        this.ownVolumesLeftOut(),
      ]);
      return {
        sizes: Object.fromEntries(volumes.map(({ name }) => [name, sizes.get(name) ?? null])),
      };
    } catch {
      throw refusal(DOCKER_CLEANUP_ERROR_CODES.dockerUnavailable);
    }
  }

  /** Every unused image and the whole build cache. */
  async prune(actor: CleanupActor): Promise<DockerPruneResult> {
    const entry = (
      outcome: AuditEntry['outcome'],
      details: Record<string, string | number> = {},
    ): AuditEntry => ({
      action: 'docker.prune',
      outcome,
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
      details,
    });

    const refused = this.changesRefusal();
    if (refused) {
      await this.auditService.tryRecord(entry('failure', { reason: refused }));
      throw refusal(refused);
    }
    // What's unused now, to count the images Docker's answer deletes (it lists layers too).
    let unused: Set<string>;
    try {
      unused = new Set((await this.dockerService.diskUsage()).images.map((image) => image.id));
    } catch {
      const code = DOCKER_CLEANUP_ERROR_CODES.dockerUnavailable;
      await this.auditService.tryRecord(entry('failure', { reason: code }));
      throw refusal(code);
    }

    // Throws if it can't be written: then nothing happens.
    await this.auditService.record(entry('requested'));

    const result = { bytesFreed: 0, images: 0 };
    try {
      const images = await this.dockerControl.pruneImages();
      result.bytesFreed = images.bytesFreed;
      result.images = new Set(
        images.deleted
          .map((id) => id.replace(/^sha256:/, '').slice(0, 12))
          .filter((id) => unused.has(id)),
      ).size;
    } catch (failure) {
      const code = codeOf(failure);
      await this.auditService.tryRecord(entry('failure', { reason: code }));
      throw refusal(code);
    }
    try {
      result.bytesFreed += (await this.dockerControl.pruneBuildCache()).bytesFreed;
    } catch (failure) {
      // The images are gone: say what was freed, and that the cache wasn't.
      const code = codeOf(failure);
      await this.auditService.tryRecord(entry('failure', { ...result, reason: code }));
      return { ...result, buildCacheFailed: true };
    }
    await this.auditService.tryRecord(entry('success', { ...result }));
    return result;
  }

  /** One volume no container uses; never one of the platform's own. */
  async removeVolume(name: string, actor: CleanupActor): Promise<void> {
    const entry = (
      outcome: AuditEntry['outcome'],
      reason?: DockerCleanupErrorCode,
    ): AuditEntry => ({
      action: 'docker.volume.remove',
      outcome,
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
      details: { volume: name, ...(reason && { reason }) },
    });

    const refused = this.changesRefusal() ?? (await this.protectionCheck(name));
    if (refused) {
      await this.auditService.tryRecord(entry('failure', refused));
      throw refusal(refused);
    }

    await this.auditService.record(entry('requested'));
    try {
      await this.dockerControl.removeVolume(name);
    } catch (failure) {
      const code = codeOf(failure);
      await this.auditService.tryRecord(entry('failure', code));
      throw refusal(code);
    }
    await this.auditService.tryRecord(entry('success'));
  }

  /**
   * An image just downloaded for an install looks unused until its container exists. A `docker
   * pull` in the terminal isn't known here.
   */
  private changesRefusal(): DockerCleanupErrorCode | null {
    return this.changesUnderway.anyApp() ? DOCKER_CLEANUP_ERROR_CODES.changesUnderway : null;
  }

  /**
   * One of the platform's own unused volumes is refused. One not in the list is in use or gone:
   * Docker's own answer says which (409, 404).
   */
  private async protectionCheck(name: string): Promise<DockerCleanupErrorCode | null> {
    try {
      const { platform } = await this.unusedVolumes();
      return platform.some((volume) => volume.name === name)
        ? DOCKER_CLEANUP_ERROR_CODES.volumeProtected
        : null;
    } catch {
      return DOCKER_CLEANUP_ERROR_CODES.dockerUnavailable;
    }
  }

  private async ownVolumesLeftOut(): Promise<DockerVolume[]> {
    return (await this.unusedVolumes()).others;
  }

  /** Unused volumes: the platform's own (its protected containers' Compose projects) and the others. */
  private async unusedVolumes(): Promise<{ platform: DockerVolume[]; others: DockerVolume[] }> {
    const [volumes, own] = await Promise.all([
      this.dockerService.unusedVolumes(),
      this.dockerService.protectedProjects(),
    ]);
    const isPlatform = (volume: DockerVolume) =>
      volume.composeProject !== null && own.has(volume.composeProject);
    return { platform: volumes.filter(isPlatform), others: volumes.filter((v) => !isPlatform(v)) };
  }
}
