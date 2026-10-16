import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  BackupFiles,
  type WrapperItemResult,
  type WrapperResult,
  type WrapperRunResult,
} from './backup-files.js';
import { BackupProgressFollower } from './backup-progress.js';
import type { FollowedRun } from './backups.model.js';

/** Runs kept in the history; older ones (and their item results) go. */
export const RUNS_KEPT = 500;

/**
 * A "Back up now" run that hasn't shown up by then never started (systemd couldn't run the
 * wrapper): recorded as failed. A run that started shows within seconds — it doesn't wait.
 */
export const START_GRACE_MS = 2 * 60_000;

/**
 * Brings the wrapper's results into the app's history: each run (scheduled or manual) and each
 * repository check from runs.jsonl, at startup and whenever it changes — and runs that crashed,
 * from the progress follower. Items' archive lists come from here (the wrapper reports what each
 * item has after pruning). Each run's outcome is audited: scheduled ones as "system", "Back up
 * now" as the user who started it (the executor audited the start).
 */
@Injectable()
export class BackupResults implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupResults.name);
  private importing: Promise<void> | null = null;
  private again = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: BackupFiles,
    private readonly audit: AuditService,
    private readonly progress: BackupProgressFollower,
  ) {
    // Listening from the start: the follower may find a crashed run during startup (its
    // onModuleInit), before this service's bootstrap — and it reports each run only once.
    progress.onInterrupted((run) => void this.recordInterrupted(run));
  }

  onApplicationBootstrap(): void {
    this.files.onChange(() => void this.import());
    void this.import();
  }

  /** Called after new results were imported. Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Imports what's new (one import at a time; a request meanwhile runs once more after it). */
  import(): Promise<void> {
    if (this.importing) {
      this.again = true;
      return this.importing;
    }
    this.importing = this.importOnce()
      .catch((error: unknown) => this.logger.error('Could not import backup results', error))
      .finally(() => {
        this.importing = null;
        if (this.again) {
          this.again = false;
          void this.import();
        }
      });
    return this.importing;
  }

  private async importOnce(): Promise<void> {
    const results = await this.files.results();
    await this.importResults(results);
    await this.recordNotStarted(results);
  }

  private async importResults(results: WrapperResult[]): Promise<void> {
    if (results.length === 0) return;
    const runIds = results.filter((r) => r.type === 'run').map((r) => r.runId);
    const checkIds = results.filter((r) => r.type === 'check').map((r) => r.checkId);
    const [finished, checks] = await Promise.all([
      this.prisma.backupRun.findMany({
        where: { id: { in: runIds }, finishedAt: { not: null } },
        select: { id: true },
      }),
      this.prisma.backupCheck.findMany({ where: { id: { in: checkIds } }, select: { id: true } }),
    ]);
    const done = new Set([...finished.map((r) => r.id), ...checks.map((c) => c.id)]);
    let imported = 0;
    for (const result of results) {
      if (result.type === 'run') {
        if (done.has(result.runId)) continue;
        await this.importRun(result);
      } else {
        if (done.has(result.checkId)) continue;
        await this.prisma.backupCheck.create({
          data: {
            id: result.checkId,
            full: result.full,
            status: result.status,
            errorCode: result.errorCode,
            startedAt: new Date(result.startedAt),
            finishedAt: new Date(result.finishedAt),
          },
        });
      }
      imported++;
    }
    if (imported > 0) {
      await this.prune();
      this.notify();
    }
  }

  private async importRun(result: WrapperRunResult): Promise<void> {
    const existing = await this.prisma.backupRun.findUnique({
      where: { id: result.runId },
      select: { finishedAt: true, startedById: true, startedBy: { select: { username: true } } },
    });
    const data = {
      trigger: result.trigger,
      itemId: result.itemId,
      status: result.status,
      errorCode: result.errorCode,
      output: result.output.join('\n'),
      startedAt: new Date(result.startedAt),
      finishedAt: new Date(result.finishedAt),
    };
    // The run and its items at once: a reader never sees a finished run with only some items.
    await this.prisma.$transaction(async (tx) => {
      await tx.backupRun.upsert({
        where: { id: result.runId },
        create: { id: result.runId, ...data },
        update: data,
      });
      await this.saveItemResults(tx, result.runId, result.items, new Date(result.finishedAt));
    });
    // Audited once: a scheduled run when it first arrives; "Back up now" when the run the app
    // started (its row, waiting for this result) ends — as the user who started it.
    const manual = result.trigger === 'manual';
    if (manual ? !existing || existing.finishedAt : existing) return;
    await this.audit.tryRecord({
      action: 'backup.run',
      outcome: result.status === 'failed' ? 'failure' : 'success',
      ...(manual
        ? { userId: existing!.startedById ?? undefined, username: existing!.startedBy?.username }
        : { username: 'system' }),
      details: {
        runId: result.runId,
        trigger: result.trigger,
        status: result.status,
        ...(result.errorCode ? { reason: result.errorCode } : {}),
      },
    });
  }

  /** Item results of a run, for items that still exist; their archive lists if newer. */
  private async saveItemResults(
    db: Prisma.TransactionClient,
    runId: string,
    items: WrapperItemResult[],
    finishedAt: Date,
  ): Promise<void> {
    const known = new Set(
      (
        await db.backupItem.findMany({
          where: { id: { in: items.map((i) => i.itemId) } },
          select: { id: true },
        })
      ).map((i) => i.id),
    );
    for (const item of items) {
      if (!known.has(item.itemId)) continue;
      const data = {
        status: item.status,
        errorCode: item.errorCode,
        archive: item.archive,
        originalBytes: item.originalBytes === null ? null : BigInt(Math.round(item.originalBytes)),
        addedBytes: item.addedBytes === null ? null : BigInt(Math.round(item.addedBytes)),
        warnings: item.warnings,
      };
      await db.backupItemResult.upsert({
        where: { runId_itemId: { runId, itemId: item.itemId } },
        create: { runId, itemId: item.itemId, ...data },
        update: data,
      });
      if (item.archives) {
        await db.backupItem.updateMany({
          where: {
            id: item.itemId,
            OR: [{ archivesAt: null }, { archivesAt: { lt: finishedAt } }],
          },
          data: { archives: item.archives, archivesAt: finishedAt },
        });
      }
    }
  }

  /** A run whose process died before it finished: recorded as failed, `interrupted`. */
  async recordInterrupted(run: FollowedRun): Promise<void> {
    try {
      const existing = await this.prisma.backupRun.findUnique({
        where: { id: run.progress.runId },
      });
      if (existing?.finishedAt) return;
      const data = {
        trigger: run.progress.trigger,
        itemId: run.itemId,
        status: 'failed' as const,
        errorCode: 'interrupted',
        output: run.progress.output.join('\n'),
        startedAt: new Date(run.progress.startedAt),
        finishedAt: new Date(),
      };
      const results = run.progress.items
        .filter((item) => item.result)
        .map((item) => ({ ...item.result!, archives: null }));
      await this.prisma.$transaction(async (tx) => {
        await tx.backupRun.upsert({
          where: { id: run.progress.runId },
          create: { id: run.progress.runId, ...data },
          update: data,
        });
        await this.saveItemResults(tx, run.progress.runId, results, data.finishedAt);
      });
      this.logger.warn(`Backup run ${run.progress.runId} ended without finishing`);
      this.notify();
    } catch (error) {
      this.logger.error('Could not record an interrupted backup run', error);
    }
  }

  /** "Back up now" runs that never showed up — not in the progress file, no result: failed. */
  private async recordNotStarted(results: WrapperResult[]): Promise<void> {
    const stale = await this.prisma.backupRun.findMany({
      where: {
        trigger: 'manual',
        finishedAt: null,
        startedAt: { lt: new Date(Date.now() - START_GRACE_MS) },
      },
      select: { id: true },
    });
    const reported = new Set(results.filter((r) => r.type === 'run').map((r) => r.runId));
    const followed = this.progress.followedRunId();
    const never = stale.filter((run) => run.id !== followed && !reported.has(run.id));
    if (never.length === 0) return;
    await this.prisma.backupRun.updateMany({
      where: { id: { in: never.map((run) => run.id) }, finishedAt: null },
      data: { status: 'failed', errorCode: 'interrupted', finishedAt: new Date() },
    });
    this.logger.warn(`${never.length} backup run(s) started with "Back up now" never ran`);
    this.notify();
  }

  private async prune(): Promise<void> {
    const old = await this.prisma.backupRun.findMany({
      orderBy: { startedAt: 'desc' },
      skip: RUNS_KEPT,
      select: { id: true },
    });
    if (old.length > 0) {
      await this.prisma.backupRun.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
