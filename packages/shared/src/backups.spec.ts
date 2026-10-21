import { describe, expect, it } from 'vitest';
import { VALIDATION_LIMITS } from './auth.js';
import {
  BACKUP_LIMITS,
  backupItemRequestSchema,
  backupPlanUpdateSchema,
  backupRestoreRequestSchema,
  backupRetentionSchema,
  backupScheduleSchema,
  backupSetupRequestSchema,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_BACKUP_SCHEDULE,
  isBackupDestinationPath,
} from './backups.js';

const ITEM = '0b6f3c1e-2d4a-4f8b-9c3e-1a2b3c4d5e6f';

/** The first message key of a failed parse, by field. */
function errors(schema: { safeParse(v: unknown): { error?: { issues: any[] } } }, value: unknown) {
  const first: Record<string, string> = {};
  for (const issue of schema.safeParse(value).error?.issues ?? []) {
    first[issue.path.join('.')] ??= issue.message;
  }
  return first;
}

describe('isBackupDestinationPath', () => {
  it('accepts folders under /mnt and /media', () => {
    for (const path of ['/mnt/backup', '/media/alice/USB Disk', '/mnt/disks/2']) {
      expect(isBackupDestinationPath(path), path).toBe(true);
    }
  });

  it('refuses the roots themselves, other places and tricks', () => {
    for (const path of [
      '/mnt',
      '/media',
      '/mnt/',
      '/mntx/backup',
      '/srv/laris',
      '/',
      '/mnt/../etc',
      '/mnt/./x',
      'mnt/backup',
      '/mnt/a\nb',
    ]) {
      expect(isBackupDestinationPath(path), JSON.stringify(path)).toBe(false);
    }
  });
});

describe('backupScheduleSchema', () => {
  it('accepts the default and the frequencies', () => {
    expect(backupScheduleSchema.parse(DEFAULT_BACKUP_SCHEDULE)).toEqual(DEFAULT_BACKUP_SCHEDULE);
    for (const frequency of ['daily', 'every12h', 'every6h']) {
      expect(backupScheduleSchema.safeParse({ frequency, time: '23:59' }).success).toBe(true);
    }
  });

  it.each(['24:00', '3:00', '03:60', '03:00:00', '03:00 ', 'Mon 03:00', '*:00'])(
    'refuses the time %j',
    (time) => {
      expect(errors(backupScheduleSchema, { frequency: 'daily', time })).toEqual({
        time: 'validation.backupTimeInvalid',
      });
    },
  );

  it('refuses other frequencies and properties', () => {
    expect(backupScheduleSchema.safeParse({ frequency: 'hourly', time: '03:00' }).success).toBe(
      false,
    );
    expect(
      backupScheduleSchema.safeParse({ ...DEFAULT_BACKUP_SCHEDULE, onCalendar: '*-*-* 03:00' })
        .success,
    ).toBe(false);
  });
});

describe('backupRetentionSchema', () => {
  it('accepts the default and the limits', () => {
    expect(backupRetentionSchema.parse(DEFAULT_BACKUP_RETENTION)).toEqual(DEFAULT_BACKUP_RETENTION);
    expect(backupRetentionSchema.safeParse({ daily: 1, weekly: 0, monthly: 0 }).success).toBe(true);
    expect(backupRetentionSchema.safeParse({ daily: 365, weekly: 104, monthly: 120 }).success).toBe(
      true,
    );
  });

  it('keeps at least one daily backup, and whole numbers in range', () => {
    expect(errors(backupRetentionSchema, { ...DEFAULT_BACKUP_RETENTION, daily: 0 })).toEqual({
      daily: 'validation.backupKeepDailyRange',
    });
    expect(errors(backupRetentionSchema, { ...DEFAULT_BACKUP_RETENTION, weekly: 105 })).toEqual({
      weekly: 'validation.backupKeepWeeklyRange',
    });
    expect(errors(backupRetentionSchema, { ...DEFAULT_BACKUP_RETENTION, monthly: -1 })).toEqual({
      monthly: 'validation.backupKeepMonthlyRange',
    });
    expect(errors(backupRetentionSchema, { ...DEFAULT_BACKUP_RETENTION, daily: 1.5 })).toEqual({
      daily: 'validation.backupKeepInvalid',
    });
  });

  it('words its messages with the same limits it checks', () => {
    expect(VALIDATION_LIMITS).toMatchObject({
      backupDailyMin: BACKUP_LIMITS.retentionDailyMin,
      backupDailyMax: BACKUP_LIMITS.retentionDailyMax,
      backupWeeklyMax: BACKUP_LIMITS.retentionWeeklyMax,
      backupMonthlyMax: BACKUP_LIMITS.retentionMonthlyMax,
    });
  });
});

describe('backupItemRequestSchema', () => {
  it('accepts a service and a folder', () => {
    expect(backupItemRequestSchema.safeParse({ kind: 'service', serviceId: ITEM }).success).toBe(
      true,
    );
    expect(
      backupItemRequestSchema.safeParse({
        kind: 'service',
        serviceId: ITEM,
        excludedFields: ['MUSIC_DIR'],
      }).success,
    ).toBe(true);
    expect(
      backupItemRequestSchema.safeParse({ kind: 'folder', path: '/home/alice/Documents' }).success,
    ).toBe(true);
  });

  it('never lets anyone add or describe the platform item', () => {
    expect(backupItemRequestSchema.safeParse({ kind: 'platform' }).success).toBe(false);
  });

  it.each(['relative', '/home/../etc', '/home/alice/', '/srv/a:b'])(
    'refuses the folder %j',
    (path) => {
      expect(errors(backupItemRequestSchema, { kind: 'folder', path })).toEqual({
        path: 'validation.pathInvalid',
      });
    },
  );

  it('refuses mixed shapes and bad field keys', () => {
    expect(
      backupItemRequestSchema.safeParse({ kind: 'folder', path: '/srv/x', serviceId: ITEM })
        .success,
    ).toBe(false);
    expect(
      backupItemRequestSchema.safeParse({
        kind: 'service',
        serviceId: ITEM,
        excludedFields: ['../x'],
      }).success,
    ).toBe(false);
  });
});

describe('backupSetupRequestSchema', () => {
  const setup = {
    destination: '/mnt/backup',
    schedule: DEFAULT_BACKUP_SCHEDULE,
    retention: DEFAULT_BACKUP_RETENTION,
    items: [{ kind: 'service', serviceId: ITEM }],
  };

  it('accepts a complete setup', () => {
    expect(backupSetupRequestSchema.safeParse(setup).success).toBe(true);
  });

  it('takes a plain absolute path as the disk (which disks are allowed is the server’s check)', () => {
    expect(errors(backupSetupRequestSchema, { ...setup, destination: '/mnt/../etc' })).toEqual({
      destination: 'validation.backupDestinationInvalid',
    });
    expect(errors(backupSetupRequestSchema, { ...setup, destination: '' })).toEqual({
      destination: 'validation.backupDestinationRequired',
    });
  });

  it('never takes a passphrase or a repository from the browser', () => {
    expect(
      backupSetupRequestSchema.safeParse({ ...setup, passphrase: 'a b c d e f' }).success,
    ).toBe(false);
    expect(backupSetupRequestSchema.safeParse({ ...setup, repository: '/tmp/x' }).success).toBe(
      false,
    );
  });

  it('changes are partial, with the same checks', () => {
    expect(backupPlanUpdateSchema.safeParse({}).success).toBe(true);
    expect(backupPlanUpdateSchema.safeParse({ destination: 'mnt/usb' }).success).toBe(false);
  });
});

describe('backupRestoreRequestSchema', () => {
  const restore = { itemId: ITEM, archive: `${ITEM}-2026-10-14T03:00:12`, target: 'inPlace' };

  it('accepts an archive of the wrapper’s naming', () => {
    expect(backupRestoreRequestSchema.safeParse(restore).success).toBe(true);
    expect(backupRestoreRequestSchema.safeParse({ ...restore, target: 'newFolder' }).success).toBe(
      true,
    );
  });

  it.each([
    'latest',
    `${ITEM}-2026-10-14`,
    `--glob-archives=*`,
    `${ITEM}-2026-10-14T03:00:12::x`,
    `../${ITEM}-2026-10-14T03:00:12`,
  ])('refuses the archive %j', (archive) => {
    expect(backupRestoreRequestSchema.safeParse({ ...restore, archive }).success).toBe(false);
  });

  it('refuses other targets, such as a free path', () => {
    expect(backupRestoreRequestSchema.safeParse({ ...restore, target: '/etc' }).success).toBe(
      false,
    );
    expect(backupRestoreRequestSchema.safeParse({ ...restore, path: '/home/alice' }).success).toBe(
      false,
    );
  });
});
