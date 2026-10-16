import { describe, expect, it } from 'vitest';
import { DISK_NAME_PATTERN, diskMountRequestSchema, suggestDiskName } from './disks.js';

const UUID = '0b6e6e2c-1111-4a6e-9f0e-6c2c8b3d1a01';

describe('diskMountRequestSchema', () => {
  it('takes a UUID (exFAT ones too) and a name for /mnt/<name>', () => {
    expect(diskMountRequestSchema.safeParse({ uuid: UUID, name: 'backup-disk' }).success).toBe(
      true,
    );
    expect(diskMountRequestSchema.safeParse({ uuid: 'AB12-CD34', name: 'usb' }).success).toBe(true);
  });

  it('refuses names that aren’t a plain folder name, with message keys', () => {
    for (const name of ['Big', '../etc', 'a/b', '-x', 'x y', 'a'.repeat(33)]) {
      const result = diskMountRequestSchema.safeParse({ uuid: UUID, name });
      expect(result.error?.issues[0].message).toBe('validation.diskNameInvalid');
    }
    expect(
      diskMountRequestSchema.safeParse({ uuid: UUID, name: '' }).error?.issues[0].message,
    ).toBe('validation.diskNameRequired');
  });

  it('refuses a UUID with path characters, and any other key', () => {
    expect(diskMountRequestSchema.safeParse({ uuid: '../sda1', name: 'x' }).success).toBe(false);
    expect(
      diskMountRequestSchema.safeParse({ uuid: UUID, name: 'x', options: 'exec' }).success,
    ).toBe(false);
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
