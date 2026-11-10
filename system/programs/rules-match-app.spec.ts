import {
  APP_NAME_PATTERN,
  BACKUP_FILESYSTEMS,
  BACKUP_FREQUENCIES,
  BACKUP_LIMITS,
  BACKUP_REPOSITORY_FOLDER,
  BACKUP_SYSTEM_FOLDERS,
  BACKUP_TIME_PATTERN,
  CATALOG_LIMITS,
  DISK_FILESYSTEMS,
  DISK_MOUNT_ROOT,
  DISK_SYSTEM_FOLDERS,
  DISK_UUID_PATTERN,
  FILES_LIMITS,
  isMountPointAllowed,
  JOURNAL_BOOT_ID_PATTERN,
  JOURNAL_CURSOR_PATTERN,
  JOURNAL_LIMITS,
  JOURNAL_PRIORITIES,
  linuxSudoRequestSchema,
  PATH_FORBIDDEN,
  PROCESS_LIMITS,
  PROCESS_SIGNALS,
  RELEASE_VERSION_PATTERN,
  UPDATE_PHASES,
  RELATIVE_PATH_PATTERN,
  SYSTEM_SERVICE_ACTIONS,
  SYSTEM_SERVICE_NAME_PATTERN,
  TEMPLATE_LABEL,
  VOLUME_NAME_PATTERN,
} from '@ilex/shared';
import {
  HELPER_ANSWER_MAX,
  HELPER_MESSAGE_MAX,
} from '../../apps/server/src/linux-sessions/linux-sessions.constants.ts';
import { scheduleHours } from '../../apps/server/src/backups/backup-status.ts';
import { ROOT_PLACES, SYSTEM_MOUNTS } from '../../apps/server/src/disks/disks.constants.ts';
import { SYSTEM_FOLDERS } from '../../apps/server/src/host/host.constants.ts';
import * as appManifest from '../../apps/server/src/updates/release-manifest.ts';
import * as appUpdates from '../../apps/server/src/updates/updates.constants.ts';
import * as wrapperConfigure from './backup/configure.mts';
import * as wrapperBackupConfig from './backup/config.mts';
import * as wrapperDestination from './backup/destination.mts';
import * as wrapperBackupInput from './backup/input.mts';
import * as wrapperPlan from './backup/plan.mts';
import * as wrapperDiskConfig from './disk/config.mts';
import * as wrapperDiskDevices from './disk/devices.mts';
import * as wrapperDiskMount from './disk/mount.mts';
import * as wrapperDiskUnits from './disk/units.mts';
import * as helperSudo from './helper/sudo.mts';
import * as helperConfig from './helper/config.mts';
import * as wrapperPaths from './lib/paths.mts';
import * as updateInstall from './update/install.mts';
import * as updateRelease from './update/release.mts';

// The app's rules and the root programs' are written twice on purpose (the programs share no code
// with the app). This keeps the two copies the same; that they are right is the programs' own
// tests and the review of system/. Compared as whole regular expressions (flags included).
describe('the app and the root programs check the same rules', () => {
  it('the folders never backed up, restored into or listed, and the characters a path may not hold', () => {
    expect(new Set(wrapperPaths.DENIED_PATHS)).toEqual(new Set(SYSTEM_FOLDERS));
    expect(new Set(wrapperPaths.DENIED_PATHS)).toEqual(new Set(BACKUP_SYSTEM_FOLDERS));
    expect(String(wrapperPaths.PATH_FORBIDDEN)).toBe(String(PATH_FORBIDDEN));
    expect(wrapperPaths.PATH_MAX).toBe(CATALOG_LIMITS.pathMax);
  });

  it('backups: disks, their formats, the repository folder, the item limit, the time', () => {
    expect(new Set(wrapperBackupConfig.SYSTEM_MOUNTS)).toEqual(new Set(SYSTEM_MOUNTS));
    expect(wrapperDestination.FILESYSTEMS).toEqual(new Set(BACKUP_FILESYSTEMS));
    expect(wrapperDestination.REPOSITORY_FOLDER).toBe(BACKUP_REPOSITORY_FOLDER);
    expect(wrapperPlan.MAX_ITEMS).toBe(BACKUP_LIMITS.maxItems);
    expect(String(wrapperPlan.TIME_PATTERN)).toBe(String(BACKUP_TIME_PATTERN));
  });

  it('backups: an app’s name and what may be skipped in its folders', () => {
    expect(String(wrapperPlan.PROJECT_PATTERN)).toBe(String(APP_NAME_PATTERN));
    expect(String(wrapperPlan.SKIP_PATTERN)).toBe(String(RELATIVE_PATH_PATTERN));
    expect(wrapperPlan.MAX_SKIPS).toBe(CATALOG_LIMITS.maxBackupSkips);
  });

  it('backups: the timer runs at the hours the app shows as the next run', () => {
    for (const frequency of BACKUP_FREQUENCIES) {
      for (const time of ['00:00', '03:15', '13:45', '23:59']) {
        const hours = scheduleHours({ frequency, time })
          .map((h) => String(h).padStart(2, '0'))
          .join(',');
        expect(wrapperConfigure.onCalendar({ frequency, time })).toBe(
          `*-*-* ${hours}:${time.slice(3)}:00`,
        );
      }
    }
  });

  it('disks: the system disk, the file systems, the mount folders, UUIDs', () => {
    expect(new Set(wrapperDiskDevices.SYSTEM_MOUNTS)).toEqual(new Set(SYSTEM_MOUNTS));
    expect(new Set(wrapperDiskUnits.FILESYSTEMS)).toEqual(new Set(DISK_FILESYSTEMS));
    expect(new Set(wrapperDiskUnits.SYSTEM_FOLDERS)).toEqual(new Set(DISK_SYSTEM_FOLDERS));
    expect(wrapperDiskConfig.ROOT_PATHS.mountRoot).toBe(DISK_MOUNT_ROOT);
    expect(ROOT_PLACES.unitDir).toBe(wrapperDiskConfig.ROOT_PATHS.unitDir);
    expect(String(wrapperDiskMount.UUID)).toBe(String(DISK_UUID_PATTERN));
    for (const where of [
      '/mnt/usb',
      '/home/anna/disk',
      '/',
      '/etc',
      '/var/x',
      '/srv/../etc',
      'x',
      '/opt/ilex/y',
      '/a b',
    ]) {
      let program = true;
      try {
        wrapperDiskMount.parseMountPoint(where);
      } catch {
        program = false;
      }
      expect(program, where).toBe(isMountPointAllowed(where));
    }
  });

  it('the helper: PIDs, signals, sudo passwords on one line, root’s idle time, app, volume and service names, the journal’s cursors, boots and limits', () => {
    expect(helperConfig.PID_MAX).toBe(PROCESS_LIMITS.maxPid);
    expect([...helperConfig.SIGNALS]).toEqual([...PROCESS_SIGNALS]);
    expect(helperConfig.PASSWORD_MAX).toBe(FILES_LIMITS.passwordMax);
    expect(helperConfig.ROOT_IDLE_MS).toBe(FILES_LIMITS.sudoIdleMinutes * 60_000);
    expect(String(helperConfig.PROJECT_PATTERN)).toBe(String(APP_NAME_PATTERN));
    expect(helperConfig.TEMPLATE_LABEL).toBe(TEMPLATE_LABEL);
    expect(helperConfig.MESSAGE_MAX).toBe(HELPER_MESSAGE_MAX);
    expect(helperConfig.COMPOSE_ANSWER_MAX).toBeLessThan(HELPER_ANSWER_MAX);
    expect(String(helperConfig.VOLUME_PATTERN)).toBe(String(VOLUME_NAME_PATTERN));
    expect(String(helperConfig.SERVICE_PATTERN)).toBe(String(SYSTEM_SERVICE_NAME_PATTERN));
    expect([...helperConfig.SERVICE_COMMANDS]).toEqual([...SYSTEM_SERVICE_ACTIONS]);
    expect(helperConfig.UNITS_ANSWER_MAX).toBeLessThan(HELPER_ANSWER_MAX);
    expect(String(helperConfig.CURSOR_PATTERN)).toBe(String(JOURNAL_CURSOR_PATTERN));
    expect(String(helperConfig.BOOT_ID_PATTERN)).toBe(String(JOURNAL_BOOT_ID_PATTERN));
    expect(helperConfig.JOURNAL_LINES_MAX).toBe(JOURNAL_LIMITS.linesPerRead);
    // The largest input a root program takes still fits in one request line, escaped at its worst.
    const largest = JSON.stringify({
      id: Number.MAX_SAFE_INTEGER,
      action: 'root.run',
      program: 'backup',
      command: 'configure',
      input: '"'.repeat(wrapperBackupInput.MAX_INPUT_BYTES),
      timeoutMs: helperConfig.ROOT_TIMEOUT_MAX_MS,
    });
    expect(Buffer.byteLength(largest)).toBeLessThan(helperConfig.LINE_MAX);
    expect(helperConfig.JOURNAL_MESSAGE_MAX).toBe(JOURNAL_LIMITS.maxMessageBytes);
    expect(helperConfig.JOURNAL_ANSWER_MAX).toBeLessThan(HELPER_ANSWER_MAX);
    expect(Math.max(...Object.values(JOURNAL_PRIORITIES))).toBe(7);
    for (const password of [
      'right',
      'with spaces and ünïcödé',
      'x'.repeat(FILES_LIMITS.passwordMax),
      'x'.repeat(FILES_LIMITS.passwordMax + 1),
      '',
      'line\nbreak',
      'carriage\rreturn',
      'nul\0byte',
      'tab\tis fine',
    ]) {
      expect(helperSudo.acceptablePassword(password), JSON.stringify(password)).toBe(
        linuxSudoRequestSchema.safeParse({ password }).success,
      );
    }
  });

  it('updates: versions, which is newer, and what a release manifest must say', () => {
    expect(updateRelease.VERSION).toEqual(RELEASE_VERSION_PATTERN);
    expect(updateRelease.ARCHIVE_MAX_BYTES).toBe(appUpdates.ARCHIVE_MAX_BYTES);
    expect(updateRelease.MANIFEST_MAX_BYTES).toBe(appUpdates.MANIFEST_MAX_BYTES);
    expect(updateRelease.RELEASE_URL).toEqual(appUpdates.RELEASE_URL);
    expect(updateRelease.DEV_RELEASE_URL).toEqual(appUpdates.DEV_RELEASE_URL);
    expect(updateInstall.JOB_PHASES).toEqual([...UPDATE_PHASES]);
    for (const [a, b] of [
      ['0.2.0', '0.1.0'],
      ['0.1.0', '0.1.0'],
      ['0.10.0', '0.9.9'],
      ['1.0.0', '0.99.99'],
      ['0.1.1', '0.1.10'],
    ] as const) {
      expect(updateRelease.newer(a, b), `${a} > ${b}`).toBe(appManifest.isNewer(a, b));
    }
    const good = {
      version: '0.2.0',
      published: '2026-11-20T10:00:00Z',
      archive: 'ilex-0.2.0.tar.gz',
      sha256: 'a'.repeat(64),
      size: 1000,
    };
    for (const manifest of [
      good,
      { ...good, notes: 'NOTES.md' },
      { ...good, notes: 'https://elsewhere/notes' },
      { ...good, archive: 'https://elsewhere/ilex-0.2.0.tar.gz' },
      { ...good, archive: '../ilex-0.2.0.tar.gz' },
      { ...good, archive: 'ilex-0.3.0.tar.gz' },
      { ...good, version: '0.2' },
      { ...good, version: '01.2.0' },
      { ...good, published: '2026-11-20' },
      { ...good, published: '2026-13-40T10:00:00Z' },
      { ...good, sha256: 'A'.repeat(64) },
      { ...good, size: 0 },
      { ...good, size: 1.5 },
      { ...good, size: appUpdates.ARCHIVE_MAX_BYTES + 1 },
      { ...good, size: '1000' },
      { ...good, extra: true },
      [good],
    ]) {
      const text = JSON.stringify(manifest);
      expect(updateRelease.parseManifest(text) !== null, text).toBe(
        appManifest.parseManifest(text) !== null,
      );
    }
    expect(appManifest.parseManifest(JSON.stringify(good))).not.toBeNull();
    expect(appManifest.parseManifest('not json')).toBeNull();
  });
});
