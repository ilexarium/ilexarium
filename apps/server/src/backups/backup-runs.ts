import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BACKUP_ERROR_CODES, type BackupRun, type BackupRunRequest } from '@ilex/shared';
import { Observable, Subject } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RootActor } from '../root-programs/root-programs.model.js';
import { RootPrograms } from '../root-programs/root-programs.js';
import { apiError, backupError } from './backup-errors.js';
import { requireItem, requirePlan, runView } from './backup-records.js';
import { RUNS_SHOWN } from './backups.constants.js';

/**
 * Backup runs: "Back up now" (started through the person's sudo; systemd runs it as its own
 * unit) and the history. Every run's progress and result come back through the program's files
 * (`BackupJobs`), whoever started it.
 */
@Injectable()
export class BackupRuns {
  private readonly changed = new Subject<void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rootPrograms: RootPrograms,
  ) {}

  /** A run was started. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  /** "Back up now": everything or one item. It goes on if the app stops. */
  async runNow(request: BackupRunRequest, actor: RootActor): Promise<{ runId: string }> {
    await requirePlan(this.prisma);
    if (request.itemId) {
      const item = await requireItem(this.prisma, request.itemId);
      if (item.removedAt) {
        throw new BadRequestException(
          apiError('Not backed up any more', BACKUP_ERROR_CODES.itemNotFound),
        );
      }
    }
    const runId = randomUUID();
    await this.prisma.backupRun.create({
      data: {
        id: runId,
        trigger: 'manual',
        itemId: request.itemId ?? null,
        status: 'running',
        startedAt: new Date(),
        startedById: actor.user.id,
      },
    });
    try {
      const outcome = await this.rootPrograms.backupStart(
        { runId, ...(request.itemId ? { itemId: request.itemId } : {}) },
        actor,
      );
      if (!outcome.ok) throw backupError(outcome.code);
    } catch (failure) {
      // Nothing started: no run to show (the audit log has the request and why it failed).
      await this.prisma.backupRun.delete({ where: { id: runId } });
      throw failure;
    }
    this.changed.next();
    return { runId };
  }

  async runs(): Promise<BackupRun[]> {
    const runs = await this.prisma.backupRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: RUNS_SHOWN,
      include: { items: true },
    });
    return runs.map((run) => runView(run));
  }

  async runOutput(id: string): Promise<{ output: string[]; omitted: number }> {
    const run = await this.prisma.backupRun.findUnique({ where: { id }, select: { output: true } });
    if (!run) throw new NotFoundException(apiError('No such run', BACKUP_ERROR_CODES.runNotFound));
    return { output: run.output ? run.output.split('\n') : [], omitted: 0 };
  }
}
