import { backupWarnings, nextRunAt, scheduleHours } from './backup-status.js';
import type { WarningInput } from './backups.model.js';

const now = new Date('2026-10-14T12:00:00');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

function input(change: Partial<WarningInput> = {}): WarningInput {
  return {
    now,
    planCreatedAt: hoursAgo(24 * 30),
    items: [{ lastSuccessAt: hoursAgo(9), lastErrorCode: null }],
    lastRun: { status: 'ok' },
    lastCheck: { status: 'ok', errorCode: null },
    destination: { mounted: true, totalBytes: 1000, freeBytes: 500 },
    ...change,
  };
}

describe('backupWarnings', () => {
  it('is quiet when all is well', () => {
    expect(backupWarnings(input())).toEqual([]);
  });

  it('warns when nothing was backed up for more than two days — the oldest item counts', () => {
    const items = [
      { lastSuccessAt: hoursAgo(9), lastErrorCode: null },
      { lastSuccessAt: hoursAgo(49), lastErrorCode: 'source_missing' },
    ];
    expect(backupWarnings(input({ items }))).toEqual(['noRecentBackup']);
    expect(
      backupWarnings(input({ items: [{ lastSuccessAt: hoursAgo(47), lastErrorCode: null }] })),
    ).toEqual([]);
  });

  it('counts a never backed up item from when the plan was set up', () => {
    const items = [{ lastSuccessAt: null, lastErrorCode: null }];
    expect(backupWarnings(input({ items, planCreatedAt: hoursAgo(2) }))).toEqual([]);
    expect(backupWarnings(input({ items, planCreatedAt: hoursAgo(50) }))).toEqual([
      'noRecentBackup',
    ]);
  });

  it('puts the most serious first', () => {
    expect(
      backupWarnings(
        input({
          items: [{ lastSuccessAt: hoursAgo(1), lastErrorCode: 'service_not_restarted' }],
          lastRun: { status: 'failed' },
          lastCheck: { status: 'failed', errorCode: 'repository_damaged' },
          destination: { mounted: true, totalBytes: 1000, freeBytes: 50 },
        }),
      ),
    ).toEqual(['serviceNotRestarted', 'repositoryDamaged', 'lastRunFailed', 'lowSpace']);
  });

  it('warns when the disk is missing', () => {
    expect(
      backupWarnings(input({ destination: { mounted: false, totalBytes: 0, freeBytes: 0 } })),
    ).toEqual(['destinationUnavailable']);
  });
});

describe('the schedule', () => {
  it('runs every 12 or 6 hours counting from its time', () => {
    expect(scheduleHours({ frequency: 'daily', time: '03:00' })).toEqual([3]);
    expect(scheduleHours({ frequency: 'every12h', time: '15:30' })).toEqual([3, 15]);
    expect(scheduleHours({ frequency: 'every6h', time: '02:00' })).toEqual([2, 8, 14, 20]);
  });

  it('knows the next run', () => {
    expect(nextRunAt({ frequency: 'daily', time: '03:00' }, now)).toEqual(
      new Date('2026-10-15T03:00:00'),
    );
    expect(nextRunAt({ frequency: 'every6h', time: '02:00' }, now)).toEqual(
      new Date('2026-10-14T14:00:00'),
    );
    expect(nextRunAt({ frequency: 'daily', time: '23:59' }, now)).toEqual(
      new Date('2026-10-14T23:59:00'),
    );
  });
});
