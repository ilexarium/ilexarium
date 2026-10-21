import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BACKUP_ERROR_CODES, type BackupRun, type BackupRunRequest } from '@laris/shared';
import { Observable, Subject } from 'rxjs';
import type { ExecutorActor } from '../executor/executor.model.js';
import { ExecutorService } from '../executor/executor.service.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { apiError, backupError, wrapperCallRaw } from './backup-errors.js';
import { BackupProgressFollower } from './backup-progress.js';
import { requireItem, requirePlan, runView } from './backup-records.js';
import { BackupResults } from './backup-results.js';

const RUNS_SHOWN = 50;
/**
 * "Back up now" keeps the one-operation slot until its run shows in the progress file (or has a
 * result): then the follower holds it, like for a scheduled run. Seconds, normally.
 */
export const HANDOVER_MS = 30_000;
const HANDOVER_POLL_MS = 200;

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
    private readonly executor: ExecutorService,
    private readonly slot: OperationSlot,
    private readonly progress: BackupProgressFollower,
    private readonly results: BackupResults,
  ) {}

  /** A run was started. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  /**
   * "Back up now": everything or one item. systemd runs it as its own unit (it goes on if the app
   * stops); its progress and result arrive through the wrapper's files, like a scheduled run's.
   */
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
    const release = this.slot.claim('backup');
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
        this.executor.backupStart(
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
    this.notify();
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
    if (!run) throw new NotFoundException(apiError('No such run', BACKUP_ERROR_CODES.itemNotFound));
    return { output: run.output ? run.output.split('\n') : [], omitted: 0 };
  }

  /** Waits until the started run shows in the progress file, or has finished (refused at once). */
  private async handOver(runId: string): Promise<void> {
    const deadline = Date.now() + HANDOVER_MS;
    while (Date.now() < deadline) {
      await this.progress.refresh();
      if (this.progress.followedRunId() === runId) return;
      await this.results.import();
      const run = await this.prisma.backupRun.findUnique({
        where: { id: runId },
        select: { finishedAt: true },
      });
      if (!run || run.finishedAt) return;
      await new Promise((resolve) => setTimeout(resolve, HANDOVER_POLL_MS));
    }
    this.logger.warn(`Backup run ${runId} hasn't started after ${HANDOVER_MS / 1000} s`);
  }

  private notify(): void {
    this.changed.next();
  }
}
