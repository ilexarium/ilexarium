import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, type JobPhase, SERVICE_ERROR_CODES, serviceProject } from '@laris/shared';
import { type Observable, Subject } from 'rxjs';
import { DockerService } from '../docker/docker.service.js';
import type { ComposeOutcome } from '../executor/executor.model.js';
import type { ServiceJob as ServiceJobRow } from '../generated/prisma/client.js';
import { jobView, LiveJob } from '../jobs/live-job.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { JOBS_KEPT } from './services.constants.js';
import type { ActiveJob } from './services.model.js';

/**
 * At most one running install or removal, in the slot shared with backups and disks. Every change
 * (phase, output, status) goes out on `changes$`, which the `services` topic follows; a finished
 * job is saved and only the last `JOBS_KEPT` per service are kept. After a restart, jobs still
 * `running` are interrupted and their services read back from Docker.
 */
@Injectable()
export class ServiceJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(ServiceJobs.name);
  private active: ActiveJob | null = null;
  private readonly changed = new Subject<void>();

  /** Every change: job phase, output, status. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  constructor(
    private readonly prisma: PrismaService,
    private readonly dockerService: DockerService,
    private readonly operationSlot: OperationSlot,
  ) {}

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
      // Service jobs are installs and removals (restores have their own table).
      const kind = job.kind === 'remove' ? 'remove' : 'deploy';
      const status = await this.statusFromDocker(job.service.catalogId, kind);
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
  claim(kind: 'deploy' | 'remove'): {
    start: (id: string, serviceId: string) => void;
    release: () => void;
  } {
    const job: ActiveJob = {
      live: new LiveJob(),
      serviceId: null,
      release: this.operationSlot.claim(kind),
    };
    this.active = job;
    return {
      start: (id, serviceId) => {
        job.live.id = id;
        job.serviceId = serviceId;
        this.notify();
      },
      release: () => {
        if (this.active === job) this.active = null;
        job.release();
      },
    };
  }

  /** The running job's phase and output, for the executor. */
  callbacks(): { onPhase: (phase: JobPhase) => void; onOutput: (line: string) => void } {
    return {
      onPhase: (phase) => {
        if (this.active) this.active.live.phase = phase;
        this.notify();
      },
      onOutput: (line) => this.appendOutput(line),
    };
  }

  /** One line of the running job's output; at most 256 KB kept, the oldest dropped first. */
  appendOutput(line: string): void {
    if (!this.active) return;
    this.active.live.append(line);
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
    if (!job?.live.id) return;
    const { live } = job;
    try {
      await this.prisma.$transaction([
        this.prisma.serviceJob.update({
          where: { id: live.id! },
          data: {
            status: outcome.ok ? 'succeeded' : 'failed',
            phase: live.phase,
            errorCode: outcome.ok ? null : outcome.code,
            errorField: outcome.ok ? null : outcome.field,
            output: live.savedOutput(),
            finishedAt: new Date(),
          },
        }),
        this.prisma.service.update({ where: { id: job.serviceId! }, data: { status } }),
      ]);
      await this.prune(job.serviceId!);
    } catch (failure) {
      this.logger.error(`Could not save the result of job ${live.id}`, failure);
    } finally {
      this.active = null;
      job.release();
      this.notify();
    }
  }

  /** A job as the API and the topic show it — live from memory while it runs; the last `lastLines` lines if given. */
  view(job: ServiceJobRow, lastLines?: number): Job {
    return jobView(job, this.active?.live ?? null, lastLines);
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
      const containers = (await this.dockerService.listContainers()).filter(
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
    this.changed.next();
  }
}
