import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AppStarted,
  BACKUP_ERROR_CODES,
  type BackupRestore,
  type BackupRestorePhase,
  type BackupRestoreRequest,
  previousVersionDeletable,
} from '@ilex/shared';
import { Observable, Subject } from 'rxjs';
import type { BackupRestore as BackupRestoreRow } from '../generated/prisma/client.js';
import { AppManager } from '../apps/app-manager.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RootActor } from '../root-programs/root-programs.model.js';
import { RootPrograms } from '../root-programs/root-programs.js';
import { BackupChecks } from './backup-checks.js';
import { apiError, backupError } from './backup-errors.js';
import { BackupJobs } from './backup-jobs.js';
import { requireItem, requirePlan } from './backup-records.js';
import { RESTORES_SHOWN } from './backups.constants.js';

/**
 * Restores: started through the person's sudo, run by systemd as their own unit
 * (`ilex-restore@<id>`) — they go on if the app stops. Their phases, output and result come back
 * through the program's job file (`BackupJobs`, which saves the result: the folders set aside are
 * the way back). The history, and "Delete previous version".
 */
@Injectable()
export class BackupRestores {
  private readonly changed = new Subject<void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rootPrograms: RootPrograms,
    private readonly backupChecks: BackupChecks,
    private readonly backupJobs: BackupJobs,
    private readonly appManager: AppManager,
  ) {}

  /** A restore started; a set-aside folder was deleted. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  async restore(request: BackupRestoreRequest, actor: RootActor): Promise<{ restoreId: string }> {
    await requirePlan(this.prisma);
    const item = await requireItem(this.prisma, request.itemId);
    if (!item.archives.includes(request.archive)) {
      throw new NotFoundException(apiError('No such backup', BACKUP_ERROR_CODES.archiveNotFound));
    }
    if (request.target !== null) this.backupChecks.checkRestoreTarget(request.target);
    const row = await this.prisma.backupRestore.create({
      data: {
        itemId: item.id,
        archive: request.archive,
        targetPath: request.target,
        status: 'running',
        startedById: actor.user.id,
      },
    });
    try {
      const outcome = await this.rootPrograms.backupRestoreStart(
        { restoreId: row.id, itemId: item.id, archive: request.archive, target: request.target },
        actor,
      );
      if (!outcome.ok) throw backupError(outcome.code);
    } catch (failure) {
      await this.prisma.backupRestore.delete({ where: { id: row.id } });
      throw failure;
    }
    this.notify();
    return { restoreId: row.id };
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
    if (!row) {
      throw new NotFoundException(apiError('No such restore', BACKUP_ERROR_CODES.restoreNotFound));
    }
    return this.view(row);
  }

  /** "Delete previous version": the folders a restore set aside. */
  async discardPrevious(id: string, actor: RootActor): Promise<BackupRestore> {
    const row = await this.prisma.backupRestore.findUnique({ where: { id } });
    if (!row || row.setAside.length === 0 || row.setAsideDeletedAt) {
      throw new NotFoundException(
        apiError('Nothing set aside', BACKUP_ERROR_CODES.restoreNotFound),
      );
    }
    if (!previousVersionDeletable(row)) {
      throw new ConflictException(
        apiError('It may be the only whole copy', BACKUP_ERROR_CODES.setAsideKept),
      );
    }
    for (const path of row.setAside) {
      const outcome = await this.rootPrograms.backupDiscard(path, actor);
      // Already gone (deleted by hand): fine.
      if (!outcome.ok && outcome.code !== BACKUP_ERROR_CODES.restoreNotFound) {
        throw backupError(outcome.code);
      }
    }
    const updated = await this.prisma.backupRestore.update({
      where: { id },
      data: { setAsideDeletedAt: new Date() },
    });
    this.notify();
    return this.view(updated);
  }

  /**
   * "Apply the restored settings": the restored app's `up` task, as the person (its folder is
   * checked by the app's own task) — offered once: the restore remembers it was used.
   */
  async apply(id: string, folder: string, actor: RootActor): Promise<AppStarted> {
    const row = await this.prisma.backupRestore.findUnique({
      where: { id },
      include: { item: { select: { project: true } } },
    });
    if (!row || row.status !== 'succeeded' || !row.appWasRunning || !row.item.project) {
      throw new NotFoundException(apiError('Nothing to apply', BACKUP_ERROR_CODES.restoreNotFound));
    }
    const started = await this.appManager.apply(
      actor.appSessionId,
      row.item.project,
      folder,
      actor,
    );
    await this.prisma.backupRestore.update({ where: { id }, data: { appWasRunning: false } });
    this.notify();
    return started;
  }

  view(row: BackupRestoreRow, lastLines?: number): BackupRestore {
    const live = this.backupJobs.restoreProgress(row.id);
    const output = live ? live.output : row.output ? row.output.split('\n') : [];
    return {
      id: row.id,
      itemId: row.itemId,
      archive: row.archive,
      targetPath: row.targetPath,
      setAside: row.setAside,
      setAsideDeleted: row.setAsideDeletedAt !== null,
      appWasRunning: row.appWasRunning,
      warnings: row.warnings,
      status: row.status,
      phase: (live?.phase ?? row.phase ?? null) as BackupRestorePhase | null,
      errorCode: row.errorCode,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      output: lastLines === undefined ? output : output.slice(-lastLines),
    };
  }

  private notify(): void {
    this.changed.next();
  }
}
