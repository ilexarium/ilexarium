import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BACKUP_ERROR_CODES, type BackupRun, type BackupRunRequest } from '@laris/shared';
import {
  concatMap,
  first,
  firstValueFrom,
  from,
  merge,
  Observable,
  startWith,
  Subject,
  timeout,
  TimeoutError,
} from 'rxjs';
import type { ExecutorActor } from '../executor/executor.model.js';
import { ExecutorService } from '../executor/executor.service.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { apiError, backupError, wrapperCallRaw } from './backup-errors.js';
import { BackupProgressFollower } from './backup-progress.js';
import { requireItem, requirePlan, runView } from './backup-records.js';
import { BackupResults } from './backup-results.js';
import { HANDOVER_MS, RUNS_SHOWN } from './backups.constants.js';

/**
 * Backup runs: "Back up now" (started through the executor; systemd runs it as its own unit) and
 * the history. Every run's progress and result come back through the wrapper's files
 * (`BackupProgressFollower`, `BackupResults`), whoever started it.
 */
@Injectable()
export class BackupRuns {
  private readonly logger = new Logger(BackupRuns.name);
  private readonly changed = new Subject<void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly executorService: ExecutorService,
    private readonly operationSlot: OperationSlot,
    private readonly backupProgressFollower: BackupProgressFollower,
    private readonly backupResults: BackupResults,
  ) {}

  /** A run was started. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  /** "Back up now": everything or one item. It goes on if the app stops. */
  async runNow(request: BackupRunRequest, actor: ExecutorActor): Promise<{ runId: string }> {
    await requirePlan(this.prisma);
    if (request.itemId) {
      const item = await requireItem(this.prisma, request.itemId);
      if (item.removedAt) {
        throw new BadRequestException(
          apiError('Not backed up any more', BACKUP_ERROR_CODES.itemNotFound),
        );
      }
    }
    const release = this.operationSlot.claim('backup');
    const runId = randomUUID();
    let handedOver = false;
    try {
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
      const outcome = await wrapperCallRaw(this.logger, () =>
        this.executorService.backupStart(
          { runId, ...(request.itemId ? { itemId: request.itemId } : {}) },
          actor,
        ),
      );
      if (!outcome.ok) {
        // Nothing started: no run to show (the audit log has the request and why it failed).
        await this.prisma.backupRun.delete({ where: { id: runId } });
        throw backupError(outcome.code);
      }
      handedOver = true;
      void this.handOver(runId)
        .catch((failure: unknown) => this.logger.error(`Following run ${runId} failed`, failure))
        .finally(release);
    } finally {
      if (!handedOver) release();
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

  /**
   * Waits until the started run shows in the progress file, or has finished (refused at once) —
   * looked at again whenever the follower or the results import report a change.
   */
  private async handOver(runId: string): Promise<void> {
    const settled$ = merge(
      this.backupProgressFollower.changes$,
      this.backupResults.changes$,
    ).pipe(
      startWith(undefined),
      concatMap(() => from(this.handedOver(runId))),
      first(Boolean),
      timeout({ first: HANDOVER_MS }),
    );
    try {
      await firstValueFrom(settled$);
    } catch (error) {
      if (!(error instanceof TimeoutError)) throw error;
      this.logger.warn(`Backup run ${runId} hasn't started after ${HANDOVER_MS / 1000} s`);
    }
  }

  private async handedOver(runId: string): Promise<boolean> {
    if (this.backupProgressFollower.followedRunId() === runId) return true;
    const run = await this.prisma.backupRun.findUnique({
      where: { id: runId },
      select: { finishedAt: true },
    });
    return !run || run.finishedAt !== null;
  }
}
