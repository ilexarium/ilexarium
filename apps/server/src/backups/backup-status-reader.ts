import { Injectable } from '@nestjs/common';
import type { BackupSchedule, BackupsStatus } from '@laris/shared';
import { SystemReader } from '../host/system-reader.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BackupChecks } from './backup-checks.js';
import { BackupProgressFollower } from './backup-progress.js';
import { itemInclude, lastSuccess, runView } from './backup-records.js';
import { BackupRestores } from './backup-restores.js';
import { backupWarnings, nextRunAt } from './backup-status.js';
import { TOPIC_LINES } from '../jobs/jobs.constants.js';

/**
 * The backups' status (the `backups` topic and `GET /backups/status`): warnings, when everything
 * was last backed up, the next run, the running run's live progress, the last results, the latest
 * restore. Its rules are pure functions in `backup-status.ts`.
 */
@Injectable()
export class BackupStatusReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: SystemReader,
    private readonly checks: BackupChecks,
    private readonly progress: BackupProgressFollower,
    private readonly restores: BackupRestores,
  ) {}

  async status(): Promise<BackupsStatus> {
    const plan = await this.prisma.backupPlan.findUnique({ where: { id: 1 } });
    const restore = await this.prisma.backupRestore.findFirst({ orderBy: { startedAt: 'desc' } });
    const restoreView = restore ? this.restores.view(restore, TOPIC_LINES) : null;
    if (!plan) {
      return {
        configured: false,
        warnings: [],
        lastSuccessAt: null,
        nextRunAt: null,
        running: this.progress.running(),
        lastRun: null,
        items: [],
        restore: restoreView,
        lastCheck: null,
      };
    }
    const [items, lastRun, lastCheck, space, mounted] = await Promise.all([
      this.prisma.backupItem.findMany({ where: { removedAt: null }, include: itemInclude }),
      this.prisma.backupRun.findFirst({
        where: { finishedAt: { not: null } },
        orderBy: { startedAt: 'desc' },
        include: { items: true },
      }),
      this.prisma.backupCheck.findFirst({ orderBy: { finishedAt: 'desc' } }),
      this.reader.space(plan.destination),
      this.checks.destinationMounted(plan.destination),
    ]);
    const now = new Date();
    const itemStates = items.map((item) => ({
      item,
      lastSuccess: lastSuccess(item.results),
      last: item.results[0] ?? null,
    }));
    const successes = itemStates.map((s) => s.lastSuccess);
    return {
      configured: true,
      warnings: backupWarnings({
        now,
        planCreatedAt: plan.createdAt,
        items: itemStates.map((s) => ({
          lastSuccessAt: s.lastSuccess,
          lastErrorCode: s.last?.errorCode ?? null,
        })),
        lastRun,
        lastCheck,
        destination: {
          mounted,
          totalBytes: space?.totalBytes ?? 0,
          freeBytes: space?.freeBytes ?? 0,
        },
      }),
      // Everything is backed up as of the item backed up longest ago.
      lastSuccessAt:
        successes.length > 0 && successes.every((s) => s !== null)
          ? new Date(Math.min(...successes.map((s) => s!.getTime()))).toISOString()
          : null,
      nextRunAt: nextRunAt(plan.schedule as BackupSchedule, now).toISOString(),
      running: this.progress.running(),
      lastRun: lastRun ? runView(lastRun) : null,
      items: itemStates.map(({ item, lastSuccess: success, last }) => ({
        id: item.id,
        kind: item.kind,
        serviceId: item.serviceId,
        lastSuccessAt: success?.toISOString() ?? null,
        lastStatus: last?.status ?? null,
      })),
      restore: restoreView,
      lastCheck: lastCheck
        ? {
            at: lastCheck.finishedAt.toISOString(),
            status: lastCheck.status,
            errorCode: lastCheck.errorCode,
          }
        : null,
    };
  }
}
