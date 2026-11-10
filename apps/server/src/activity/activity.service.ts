import { Injectable } from '@nestjs/common';
import { ACTIVITY_ACTIONS, ACTIVITY_LIMIT, type ActivityItem } from '@ilex/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { fromAlert, fromAudit, fromBackupRun, mergeActivity } from './activity-items.js';

/**
 * The dashboard's "Recent activity" (docs/plans/dashboard_v2.md): what people did (the audit
 * log's successes of a few actions), backup runs (scheduled ones too) and alerts, merged.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async recent(): Promise<ActivityItem[]> {
    const take = ACTIVITY_LIMIT;
    const [events, runs, opened, closed] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where: { action: { in: [...ACTIVITY_ACTIONS] }, outcome: 'success' },
        orderBy: { at: 'desc' },
        take,
      }),
      this.prisma.backupRun.findMany({
        where: { finishedAt: { not: null }, status: { not: 'running' } },
        orderBy: { finishedAt: 'desc' },
        take,
      }),
      this.prisma.alert.findMany({ orderBy: { openedAt: 'desc' }, take }),
      this.prisma.alert.findMany({
        where: { closedAt: { not: null } },
        orderBy: { closedAt: 'desc' },
        take,
      }),
    ]);
    const alerts = new Map([...opened, ...closed].map((row) => [row.id, row]));
    return mergeActivity(
      [
        ...events.map((event) => fromAudit(event)),
        ...runs.map(fromBackupRun),
        ...[...alerts.values()].flatMap((row) => fromAlert(row)),
      ],
      take,
    );
  }
}
