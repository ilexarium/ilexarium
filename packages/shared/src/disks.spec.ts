import { describe, expect, it } from 'vitest';
import {
  DISK_NAME_PATTERN,
  diskMountRequestSchema,
  isMountPointAllowed,
  suggestDiskName,
} from './disks.js';

const UUID = '0b6e6e2c-1111-4a6e-9f0e-6c2c8b3d1a01';

describe('diskMountRequestSchema', () => {
  const mount = { uuid: UUID, mountPoint: '/mnt/backup-disk', makeMine: false };

  it('takes a UUID (exFAT ones too), a folder anywhere but the system’s, and "make it mine"', () => {
    expect(diskMountRequestSchema.safeParse(mount).success).toBe(true);
    expect(
      diskMountRequestSchema.safeParse({
        ...mount,
        uuid: 'AB12-CD34',
        mountPoint: '/home/anna/disk',
        makeMine: true,
      }).success,
    ).toBe(true);
  });

  it('refuses system folders and tricks, with message keys', () => {
    for (const mountPoint of [
      '/',
      '/etc',
      '/var/data',
      '/usr/local/x',
      '/mnt/../etc',
      'mnt/x',
      '/opt/laris',
    ]) {
      const result = diskMountRequestSchema.safeParse({ ...mount, mountPoint });
      expect(result.error?.issues[0].message, mountPoint).toBe('validation.mountPointInvalid');
    }
    expect(
      diskMountRequestSchema.safeParse({ ...mount, mountPoint: '' }).error?.issues[0].message,
    ).toBe('validation.mountPointRequired');
  });

  it('refuses a UUID with path characters, and any other key', () => {
    expect(diskMountRequestSchema.safeParse({ ...mount, uuid: '../sda1' }).success).toBe(false);
    expect(diskMountRequestSchema.safeParse({ ...mount, options: 'exec' }).success).toBe(false);
  });
});

describe('isMountPointAllowed', () => {
  it('anywhere but the system’s folders', () => {
    expect(isMountPointAllowed('/srv/disk')).toBe(true);
    expect(isMountPointAllowed('/run/media/x')).toBe(false);
  });
});

describe('suggestDiskName', () => {
  it('makes a name from the label, and one that is free', () => {
    expect(suggestDiskName('My Backup Disk')).toBe('my-backup-disk');
    expect(suggestDiskName('Fotos & Videos (2024)')).toBe('fotos-videos-2024');
    expect(suggestDiskName('Élan')).toBe('elan');
    expect(suggestDiskName(null)).toBe('disk');
    expect(suggestDiskName('###')).toBe('disk');
    expect(suggestDiskName('usb', ['usb', 'usb-2'])).toBe('usb-3');
    expect(DISK_NAME_PATTERN.test(suggestDiskName('x'.repeat(100), ['x'.repeat(29)]))).toBe(true);
  });
});
