import { describe, expect, it } from 'vitest';
import { VALIDATION_LIMITS } from './auth.js';
import {
  BACKUP_LIMITS,
  backupItemRequestSchema,
  backupPlanUpdateSchema,
  backupRecoveryCheckRequestSchema,
  backupRecoveryRequestSchema,
  backupRestoreRequestSchema,
  backupRetentionSchema,
  backupScheduleSchema,
  backupSetupRequestSchema,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_BACKUP_SCHEDULE,
  isBackupFolder,
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

describe('isBackupFolder', () => {
  it('accepts any folder but the system’s', () => {
    for (const path of ['/home/alice/Documents', '/srv/media', '/mnt/usb', '/data', '/opt/other']) {
      expect(isBackupFolder(path), path).toBe(true);
    }
  });

  it('refuses system folders, what holds them, and tricks', () => {
    for (const path of [
      '/',
      '/etc',
      '/etc/ssh',
      '/var/lib/docker/x',
      '/opt/ilex',
      '/var',
      '/home/../etc',
      'relative',
    ]) {
      expect(isBackupFolder(path), JSON.stringify(path)).toBe(false);
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
  const app = { kind: 'app', project: 'immich', folders: [], skip: [], mode: 'live' };

  it('accepts an app (its folders from Docker when none are given) and a folder', () => {
    expect(backupItemRequestSchema.safeParse(app).success).toBe(true);
    expect(
      backupItemRequestSchema.safeParse({
        ...app,
        folders: ['/home/anna/apps/immich'],
        skip: ['/home/anna/apps/immich/library/thumbs', '/home/anna/apps/immich/*.tmp'],
      }).success,
    ).toBe(true);
    expect(
      backupItemRequestSchema.safeParse({ kind: 'folder', path: '/home/alice/Documents' }).success,
    ).toBe(true);
  });

  it('never lets anyone add or describe the platform item', () => {
    expect(backupItemRequestSchema.safeParse({ kind: 'platform' }).success).toBe(false);
  });

  it.each(['relative', '/home/../etc', '/home/alice/'])('refuses the folder %j', (path) => {
    expect(errors(backupItemRequestSchema, { kind: 'folder', path })).toEqual({
      path: 'validation.pathInvalid',
    });
  });

  it('refuses a system folder, a bad project, a skip outside a path', () => {
    expect(errors(backupItemRequestSchema, { kind: 'folder', path: '/etc' })).toEqual({
      path: 'validation.backupFolderSystem',
    });
    expect(backupItemRequestSchema.safeParse({ ...app, project: 'Bad Name' }).success).toBe(false);
    expect(backupItemRequestSchema.safeParse({ ...app, skip: ['relative'] }).success).toBe(false);
    expect(backupItemRequestSchema.safeParse({ ...app, skip: ['/x/../y'] }).success).toBe(false);
    expect(backupItemRequestSchema.safeParse({ ...app, mode: 'pause' }).success).toBe(false);
  });
});

describe('backupSetupRequestSchema', () => {
  const setup = {
    destination: '/mnt/backup',
    schedule: DEFAULT_BACKUP_SCHEDULE,
    retention: DEFAULT_BACKUP_RETENTION,
    items: [{ kind: 'app', project: 'navidrome', folders: [], skip: [], mode: 'stop' }],
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
  const restore = { itemId: ITEM, archive: `${ITEM}-2026-10-14T03:00:12`, target: null };

  it('accepts an archive of the program’s naming, back where it was or into a folder', () => {
    expect(backupRestoreRequestSchema.safeParse(restore).success).toBe(true);
    expect(
      backupRestoreRequestSchema.safeParse({ ...restore, target: '/home/anna/restored' }).success,
    ).toBe(true);
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

  it('refuses a system folder or an unknown key', () => {
    expect(backupRestoreRequestSchema.safeParse({ ...restore, target: '/etc' }).success).toBe(
      false,
    );
    expect(backupRestoreRequestSchema.safeParse({ ...restore, path: '/home/alice' }).success).toBe(
      false,
    );
  });
});

describe('restoring Ilexarium from the backup disk', () => {
  const repository = '/mnt/usb/ilex-backups';
  const passphrase = 'acorn bagel cactus dolphin ember fjord';

  it('checks a repository with its passphrase — never half of it, never nothing', () => {
    expect(backupRecoveryCheckRequestSchema.safeParse({}).success).toBe(false);
    expect(backupRecoveryCheckRequestSchema.safeParse({ repository, passphrase }).success).toBe(
      true,
    );
    expect(backupRecoveryCheckRequestSchema.safeParse({ repository }).success).toBe(false);
    expect(backupRecoveryCheckRequestSchema.safeParse({ passphrase }).success).toBe(false);
    expect(backupRecoveryCheckRequestSchema.safeParse({ other: 1 }).success).toBe(false);
  });

  it('takes only a backups folder, a one-line passphrase and an archive name', () => {
    const archive = '0193a000-0000-7000-8000-000000000001-2026-11-26T03:00:00';
    const ok = { repository, passphrase, archive };
    expect(backupRecoveryRequestSchema.safeParse(ok).success).toBe(true);
    for (const change of [
      { repository: '/mnt/usb' },
      { repository: '/etc/ilex-backups' },
      { repository: 'mnt/usb/ilex-backups' },
      { passphrase: '' },
      { passphrase: 'two\nlines' },
      { passphrase: 'x'.repeat(1025) },
      { archive: 'latest' },
    ]) {
      expect(
        backupRecoveryRequestSchema.safeParse({ ...ok, ...change }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
  });
});
