import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  BACKUP_ERROR_CODES,
  type BackupRestore,
  type BackupRestoreRequest,
  type JobPhase,
} from '@laris/shared';
import { Observable, Subject } from 'rxjs';
import type { BackupOutcome, ExecutorActor } from '../executor/executor.model.js';
import { ExecutorService } from '../executor/executor.service.js';
import type { BackupRestore as BackupRestoreRow } from '../generated/prisma/client.js';
import { jobView, LiveJob } from '../jobs/live-job.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { apiError, backupError, wrapperCallRaw } from './backup-errors.js';
import { requireItem, requirePlan } from './backup-records.js';
import { RESTORES_KEPT, RESTORES_SHOWN } from './backups.constants.js';

/**
 * Restores: starting one (a job in the one slot for privileged operations, its phase and output
 * live, its result saved — where it went, the folders set aside), the history, and "Delete
 * previous version". After a restart, restores that were running are marked interrupted. Every
 * change goes to listeners (the `backups` topic).
 */
@Injectable()
export class BackupRestores implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupRestores.name);
  private active: { live: LiveJob; release: () => void } | null = null;
  private readonly changed = new Subject<void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly executorService: ExecutorService,
    private readonly operationSlot: OperationSlot,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const stale = await this.prisma.backupRestore.updateMany({
      where: { status: 'running' },
      data: {
        status: 'interrupted',
        errorCode: BACKUP_ERROR_CODES.interrupted,
        finishedAt: new Date(),
      },
    });
    if (stale.count > 0)
      this.logger.warn(`${stale.count} restore(s) were interrupted by a restart`);
  }

  /** A restore started, moved on or ended; a set-aside folder was deleted. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  async restore(
    request: BackupRestoreRequest,
    actor: ExecutorActor,
  ): Promise<{ restoreId: string; jobId: string }> {
    await requirePlan(this.prisma);
    const item = await requireItem(this.prisma, request.itemId);
    if (!item.archives.includes(request.archive)) {
      throw new NotFoundException(apiError('No such backup', BACKUP_ERROR_CODES.archiveNotFound));
    }
    if (request.target === 'inPlace' && item.kind !== 'service') {
      throw new BadRequestException(
        apiError('Only services are restored in place', BACKUP_ERROR_CODES.pathNotAllowed),
      );
    }
    const claim = this.claim();
    try {
      const row = await this.prisma.backupRestore.create({
        data: {
          itemId: item.id,
          archive: request.archive,
          target: request.target,
          status: 'running',
          startedById: actor.user.id,
        },
      });
      claim.start(row.id);
      void this.execute(row.id, request, actor);
      return { restoreId: row.id, jobId: row.id };
    } catch (failure) {
      claim.release();
      throw failure;
    }
  }

  async restores(): Promise<BackupRestore[]> {
    const rows = await this.prisma.backupRestore.findMany({
      orderBy: { startedAt: 'desc' },
      take: RESTORES_SHOWN,
    });
    return rows.map((row) => this.view(row));
  }

  async restoreJob(id: string): Promise<BackupRestore> {
    const row = await this.prisma.backupRestore.findUnique({ where: { id } });
    if (!row)
      throw new NotFoundException(apiError('No such restore', BACKUP_ERROR_CODES.restoreNotFound));
    return this.view(row);
  }

  /** "Delete previous version": the folders a restore in place set aside. */
  async discardPrevious(id: string, actor: ExecutorActor): Promise<BackupRestore> {
    const row = await this.prisma.backupRestore.findUnique({ where: { id } });
    if (!row || row.setAside.length === 0 || row.setAsideDeletedAt) {
      throw new NotFoundException(
        apiError('Nothing set aside', BACKUP_ERROR_CODES.restoreNotFound),
      );
    }
    const release = this.operationSlot.claim('backupTask');
    try {
      for (const path of row.setAside) {
        const outcome = await wrapperCallRaw(this.logger, () =>
          this.executorService.backupDiscard(path, actor),
        );
        // Already gone (deleted by hand): fine.
        if (!outcome.ok && outcome.code !== BACKUP_ERROR_CODES.restoreNotFound) {
          throw backupError(outcome.code);
        }
      }
    } finally {
      release();
    }
    const updated = await this.prisma.backupRestore.update({
      where: { id },
      data: { setAsideDeletedAt: new Date() },
    });
    this.notify();
    return this.view(updated);
  }

  view(row: BackupRestoreRow, lastLines?: number): BackupRestore {
    return {
      id: row.id,
      itemId: row.itemId,
      archive: row.archive,
      target: row.target,
      targetPath: row.targetPath,
      setAside: row.setAside,
      setAsideDeleted: row.setAsideDeletedAt !== null,
      job: jobView(row, this.active?.live ?? null, lastLines),
    };
  }

  // Inside.

  private async execute(
    id: string,
    request: BackupRestoreRequest,
    actor: ExecutorActor,
  ): Promise<void> {
    const outcome = await wrapperCallRaw(this.logger, () =>
      this.executorService.backupRestore({ restoreId: id, ...request }, actor, this.callbacks()),
    );
    await this.finish(outcome);
  }

  /** Takes the slot before any await; `start` once the row exists, `release` if it never will. */
  private claim(): { start: (id: string) => void; release: () => void } {
    const job = { live: new LiveJob(), release: this.operationSlot.claim('restore') };
    this.active = job;
    return {
      start: (id) => {
        job.live.id = id;
        this.notify();
      },
      release: () => {
        if (this.active === job) this.active = null;
        job.release();
      },
    };
  }

  private callbacks(): { onPhase: (phase: JobPhase) => void; onOutput: (line: string) => void } {
    return {
      onPhase: (phase) => {
        if (this.active) this.active.live.phase = phase;
        this.notify();
      },
      onOutput: (line) => {
        this.active?.live.append(line);
        this.notify();
      },
    };
  }

  /** Saves the running restore's result, then frees the slot. */
  private async finish(
    outcome: BackupOutcome<{ targetPath: string | null; setAside: string[] }>,
  ): Promise<void> {
    const job = this.active;
    if (!job?.live.id) return;
    const { live } = job;
    try {
      await this.prisma.backupRestore.update({
        where: { id: live.id! },
        data: {
          status: outcome.ok ? 'succeeded' : 'failed',
          phase: live.phase,
          errorCode: outcome.ok ? null : outcome.code,
          targetPath: outcome.result?.targetPath ?? null,
          // Folders set aside are kept even when the start afterwards failed: they're the way back.
          setAside: outcome.result?.setAside ?? [],
          output: live.savedOutput(),
          finishedAt: new Date(),
        },
      });
      await this.prune();
    } catch (failure) {
      this.logger.error(`Could not save the result of restore ${live.id}`, failure);
    } finally {
      this.active = null;
      job.release();
      this.notify();
    }
  }

  private notify(): void {
    this.changed.next();
  }

  /** Old restores go — but never one whose set-aside folders are still there (the list of them). */
  private async prune(): Promise<void> {
    const old = await this.prisma.backupRestore.findMany({
      orderBy: { startedAt: 'desc' },
      skip: RESTORES_KEPT,
      select: { id: true, setAside: true, setAsideDeletedAt: true },
    });
    const removable = old.filter((r) => r.setAside.length === 0 || r.setAsideDeletedAt !== null);
    if (removable.length > 0) {
      await this.prisma.backupRestore.deleteMany({
        where: { id: { in: removable.map((r) => r.id) } },
      });
    }
  }
}
