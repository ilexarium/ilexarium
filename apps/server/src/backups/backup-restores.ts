import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { BACKUP_ERROR_CODES, type BackupRestore, type JobPhase } from '@homelab/shared';
import type { BackupOutcome } from '../executor/executor.model.js';
import type { BackupRestore as BackupRestoreRow } from '../generated/prisma/client.js';
import { jobView, LiveJob } from '../jobs/live-job.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import { PrismaService } from '../prisma/prisma.service.js';

const RESTORES_KEPT = 50;

/**
 * Running restores: a job in the one slot for privileged operations, its phase and output live,
 * its result saved (where it went, the folders set aside) — and after a restart, restores that
 * were running marked interrupted. Every change goes to listeners (the `backups` topic).
 */
@Injectable()
export class BackupRestores implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupRestores.name);
  private active: { live: LiveJob; release: () => void } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly slot: OperationSlot,
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

  /** Called on every change. Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Takes the slot before any await; `start` once the row exists, `release` if it never will. */
  claim(): { start: (id: string) => void; release: () => void } {
    const job = { live: new LiveJob(), release: this.slot.claim('restore') };
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

  callbacks(): { onPhase: (phase: JobPhase) => void; onOutput: (line: string) => void } {
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
  async finish(
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

  notify(): void {
    for (const listener of this.listeners) listener();
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
