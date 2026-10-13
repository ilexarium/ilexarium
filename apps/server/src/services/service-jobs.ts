import { ConflictException, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  type JobPhase,
  SERVICE_ERROR_CODES,
  type ServiceJob,
  serviceProject,
} from '@homelab/shared';
import { DockerService } from '../docker/docker.service.js';
import type { ComposeOutcome } from '../executor/executor.model.js';
import type { ServiceJob as ServiceJobRow } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ActiveJob } from './services.model.js';

/** Output kept per job (the end matters most when something failed). */
const MAX_OUTPUT_BYTES = 256 * 1024;
const JOBS_KEPT = 20;

/**
 * Running install and removal jobs: one at a time, platform-wide (the wrapper's lock enforces the
 * same as root); the running job's phase and output, live; saving its result; keeping the last 20
 * per service; and, after a restart, marking jobs that were running as interrupted and reading
 * their services' state back from Docker. Every change goes to listeners (the `services` topic).
 */
@Injectable()
export class ServiceJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(ServiceJobs.name);
  private active: ActiveJob | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly docker: DockerService,
  ) {}

  /** Called on every change (job phase, output, status). Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Jobs the app was running when it stopped are `interrupted`; their services are read back from Docker. */
  async onApplicationBootstrap(): Promise<void> {
    const stale = await this.prisma.serviceJob.findMany({
      where: { status: 'running' },
      include: { service: true },
    });
    for (const job of stale) {
      await this.prisma.serviceJob.update({
        where: { id: job.id },
        data: {
          status: 'interrupted',
          errorCode: SERVICE_ERROR_CODES.interrupted,
          finishedAt: new Date(),
        },
      });
      const status = await this.statusFromDocker(job.service.catalogId, job.kind);
      await this.prisma.service.update({ where: { id: job.serviceId }, data: { status } });
      this.logger.warn(
        `Job ${job.id} (${job.kind} ${job.service.catalogId}) was interrupted; service is ${status}`,
      );
    }
  }

  /**
   * Takes the one slot, before any await — so two requests can't both pass. `start` once the
   * job's row exists; `release` if the request fails before that.
   */
  claim(): { start: (id: string, serviceId: string) => void; release: () => void } {
    if (this.active) {
      throw new ConflictException({
        message: 'Another install or removal is running',
        code: SERVICE_ERROR_CODES.busy,
      });
    }
    const job: ActiveJob = {
      id: null,
      serviceId: null,
      phase: null,
      lines: [],
      bytes: 0,
      omitted: 0,
    };
    this.active = job;
    return {
      start: (id, serviceId) => {
        job.id = id;
        job.serviceId = serviceId;
        this.notify();
      },
      release: () => {
        if (this.active === job) this.active = null;
      },
    };
  }

  /** The running job's phase and output, for the executor. */
  callbacks(): { onPhase: (phase: JobPhase) => void; onOutput: (line: string) => void } {
    return {
      onPhase: (phase) => {
        if (this.active) this.active.phase = phase;
        this.notify();
      },
      onOutput: (line) => this.appendOutput(line),
    };
  }

  /** One line of the running job's output; at most 256 KB kept, the oldest dropped first. */
  appendOutput(line: string): void {
    const job = this.active;
    if (!job) return;
    job.lines.push(line);
    job.bytes += Buffer.byteLength(line) + 1;
    while (job.bytes > MAX_OUTPUT_BYTES && job.lines.length > 1) {
      job.bytes -= Buffer.byteLength(job.lines.shift()!) + 1;
      job.omitted++;
    }
    this.notify();
  }

  /** The executor rejects only when the audit log couldn't record the request: then nothing ran. */
  async execute(run: () => Promise<ComposeOutcome>): Promise<ComposeOutcome> {
    try {
      return await run();
    } catch (failure) {
      this.logger.error('Could not record the request in the audit log; nothing ran', failure);
      return { ok: false, code: SERVICE_ERROR_CODES.auditUnavailable, field: null };
    }
  }

  /** Saves the running job's result and its service's new status, then frees the slot. */
  async finish(outcome: ComposeOutcome, status: 'installed' | 'failed' | 'removed'): Promise<void> {
    const job = this.active;
    if (!job?.id) return;
    try {
      const output = [
        ...(job.omitted > 0 ? [`[… ${job.omitted} earlier lines not kept]`] : []),
        ...job.lines,
      ].join('\n');
      await this.prisma.$transaction([
        this.prisma.serviceJob.update({
          where: { id: job.id },
          data: {
            status: outcome.ok ? 'succeeded' : 'failed',
            phase: job.phase,
            errorCode: outcome.ok ? null : outcome.code,
            errorField: outcome.ok ? null : outcome.field,
            output,
            finishedAt: new Date(),
          },
        }),
        this.prisma.service.update({ where: { id: job.serviceId! }, data: { status } }),
      ]);
      await this.prune(job.serviceId!);
    } catch (failure) {
      this.logger.error(`Could not save the result of job ${job.id}`, failure);
    } finally {
      this.active = null;
      this.notify();
    }
  }

  /** A job as the API and the topic show it — live from memory while it runs; the last `lastLines` lines if given. */
  view(job: ServiceJobRow, lastLines?: number): ServiceJob {
    const live = this.active?.id === job.id ? this.active : null;
    const lines = live ? live.lines : job.output ? job.output.split('\n') : [];
    const shown = lastLines === undefined ? lines : lines.slice(-lastLines);
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      phase: ((live ? live.phase : job.phase) ?? null) as JobPhase | null,
      errorCode: job.errorCode,
      errorField: job.errorField,
      startedAt: job.startedAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
      output: shown,
      omitted: lines.length - shown.length + (live ? live.omitted : 0),
    };
  }

  private async prune(serviceId: string): Promise<void> {
    const old = await this.prisma.serviceJob.findMany({
      where: { serviceId },
      orderBy: { startedAt: 'desc' },
      skip: JOBS_KEPT,
      select: { id: true },
    });
    if (old.length > 0) {
      await this.prisma.serviceJob.deleteMany({ where: { id: { in: old.map((j) => j.id) } } });
    }
  }

  private async statusFromDocker(
    catalogId: string,
    kind: 'deploy' | 'remove',
  ): Promise<'installed' | 'failed' | 'removed'> {
    const project = serviceProject(catalogId);
    try {
      const containers = (await this.docker.listContainers()).filter(
        (c) => c.composeProject === project,
      );
      if (kind === 'remove') return containers.length === 0 ? 'removed' : 'installed';
      return containers.length > 0 && containers.every((c) => c.state === 'running')
        ? 'installed'
        : 'failed';
    } catch {
      return kind === 'remove' ? 'installed' : 'failed';
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
