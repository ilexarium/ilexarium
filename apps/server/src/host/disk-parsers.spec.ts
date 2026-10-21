import {
  DISK_UNIT_MARKER,
  diskMounts,
  parseDiskUnit,
  parseMountInfo,
  parseMounts,
  parseSwaps,
  parseUdevData,
} from './disk-parsers.js';

describe('parseMounts and diskMounts', () => {
  const mounts = [
    '/dev/vda2 / ext4 rw,relatime 0 0',
    'devtmpfs /dev devtmpfs rw,nosuid 0 0',
    'tmpfs /dev/shm tmpfs rw,nosuid,nodev 0 0',
    'proc /proc proc rw 0 0',
    'sysfs /sys sysfs rw 0 0',
    'cgroup2 /sys/fs/cgroup cgroup2 rw 0 0',
    '/dev/vda1 /boot vfat rw 0 0',
    '/dev/sdb1 /mnt/media\\040files ext4 rw 0 0',
    '/dev/vda2 /var/lib/docker ext4 rw 0 0',
    'overlay /var/lib/docker/overlay2/abc/merged overlay rw 0 0',
    '/dev/loop3 /snap/core/123 squashfs ro 0 0',
    'nas:/export /mnt/nas nfs4 rw 0 0',
    'tank/data /tank/data zfs rw 0 0',
    '',
  ].join('\n');

  it('decodes octal escapes', () => {
    expect(parseMounts(mounts)).toContainEqual({
      device: '/dev/sdb1',
      mount: '/mnt/media files',
      fsType: 'ext4',
    });
  });

  it('keeps real local filesystems, one per device', () => {
    expect(diskMounts(parseMounts(mounts))).toEqual([
      { device: '/dev/vda2', mount: '/', fsType: 'ext4' },
      { device: '/dev/vda1', mount: '/boot', fsType: 'vfat' },
      { device: '/dev/sdb1', mount: '/mnt/media files', fsType: 'ext4' },
      { device: 'tank/data', mount: '/tank/data', fsType: 'zfs' },
    ]);
  });
});

describe('parseMountInfo', () => {
  it('reads mount points, their types and devices, unescaping spaces', () => {
    const text = [
      '22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw',
      '95 22 8:17 / /media/alice/My\\040Disk rw,nosuid shared:50 - exfat /dev/sdb1 rw,uid=1000',
      '96 22 0:45 / /run/user/1000 rw shared:60 - tmpfs tmpfs rw',
      'garbage',
    ].join('\n');
    expect(parseMountInfo(text)).toEqual([
      { mount: '/', device: '259:2', fsType: 'ext4', source: '/dev/nvme0n1p2' },
      { mount: '/media/alice/My Disk', device: '8:17', fsType: 'exfat', source: '/dev/sdb1' },
      { mount: '/run/user/1000', device: '0:45', fsType: 'tmpfs', source: 'tmpfs' },
    ]);
  });
});

describe('parseUdevData', () => {
  it('keeps the E: properties only', () => {
    const data = 'S:disk/by-uuid/1234\nE:ID_FS_TYPE=ext4\nE:ID_FS_LABEL=Photos\nG:systemd\n';
    expect([...parseUdevData(data)]).toEqual([
      ['ID_FS_TYPE', 'ext4'],
      ['ID_FS_LABEL', 'Photos'],
    ]);
  });
});

describe('parseSwaps', () => {
  it('names swap devices by kernel name, leaving swap files out', () => {
    const swaps = [
      'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority',
      '/dev/sda2                               partition\t8388604\t\t0\t\t-2',
      '/swapfile                               file\t\t1048572\t\t0\t\t-3',
      '/dev/mapper/vg-swap                     partition\t2097148\t\t0\t\t-4',
    ].join('\n');
    expect(parseSwaps(swaps)).toEqual(['sda2', 'vg-swap']);
  });
});

describe('parseDiskUnit', () => {
  const unit = (marker: string, what: string) =>
    `${marker}\n[Mount]\nWhat=${what}\nWhere=/mnt/photos\nType=ext4\n`;

  it('reads our units: the disk by UUID and the folder', () => {
    expect(parseDiskUnit(unit(DISK_UNIT_MARKER, '/dev/disk/by-uuid/1234-abcd'))).toEqual({
      uuid: '1234-abcd',
      where: '/mnt/photos',
    });
    expect(parseDiskUnit(unit(DISK_UNIT_MARKER, '/dev/sdb1'))).toEqual({
      uuid: null,
      where: '/mnt/photos',
    });
  });

  it('ignores anyone else’s unit', () => {
    expect(parseDiskUnit(unit('# Written by hand', '/dev/sdb1'))).toBeNull();
    expect(parseDiskUnit(`${DISK_UNIT_MARKER}\n[Mount]\nWhat=/dev/sdb1\n`)).toBeNull();
  });
});
