import type { BlockDevice, MountPoint } from '../host/host.model.js';
import { disksStatus, systemDisks } from './disk-status.js';

const isPartition = (name: string) => /^sd[a-z]\d|^vd[a-z]\d/.test(name);
const device = (name: string, number: string, change: Partial<BlockDevice> = {}): BlockDevice => ({
  name,
  number,
  partition: isPartition(name),
  disk: isPartition(name) ? name.replace(/\d+$/, '') : name,
  partitions: [],
  holders: [],
  slaves: [],
  sizeBytes: 1000,
  removable: false,
  model: null,
  fsType: null,
  uuid: null,
  label: null,
  ...change,
});

const mount = (where: string, number: string, source = ''): MountPoint => ({
  mount: where,
  device: number,
  fsType: 'ext4',
  source,
});

const devices = (): BlockDevice[] => [
  device('vda', '253:0', { partitions: ['vda1', 'vda2', 'vda3'] }),
  device('vda1', '253:1', { fsType: 'vfat', uuid: 'B007' }),
  device('vda2', '253:2', { fsType: 'ext4', uuid: 'root' }),
  device('vda3', '253:3', { fsType: 'ext4', uuid: 'spare' }),
  device('sdb', '8:16', {
    partitions: ['sdb1', 'sdb2', 'sdb3', 'sdb4'],
    removable: true,
    model: 'USB',
  }),
  device('sdb1', '8:17', { fsType: 'ext4', uuid: 'u1', label: 'Backups' }),
  device('sdb2', '8:18', { fsType: 'exfat', uuid: 'u2' }),
  device('sdb3', '8:19', { fsType: 'ntfs', uuid: 'u3' }),
  device('sdb4', '8:20', { fsType: 'crypto_LUKS', uuid: 'u4' }),
  device('sdc', '8:32', { fsType: 'btrfs', uuid: 'u5' }),
];

const systemMounts = [mount('/', '253:2'), mount('/boot', '253:1')];

describe('disksStatus', () => {
  it('gives every partition its state, the system disk last', () => {
    const { disks } = disksStatus({
      devices: devices(),
      mounts: [...systemMounts, mount('/mnt/usb', '8:17')],
      swaps: [],
      units: [{ uuid: 'u1', where: '/mnt/usb' }],
      backupDestination: '/mnt/usb',
    });
    expect(disks.map((d) => [d.device, d.system])).toEqual([
      ['sdb', false],
      ['sdc', false],
      ['vda', true],
    ]);
    const states = Object.fromEntries(
      disks.flatMap((d) => d.partitions).map((p) => [p.device, p.state]),
    );
    expect(states).toEqual({
      sdb1: 'mounted',
      sdb2: 'available',
      sdb3: 'unsupported',
      sdb4: 'inUse',
      // A disk formatted whole is its own only partition.
      sdc: 'available',
      // Every partition of the system's disk, mounted or not.
      vda1: 'system',
      vda2: 'system',
      vda3: 'system',
    });
    const usb = disks[0].partitions[0];
    expect(usb).toMatchObject({
      mountPoint: '/mnt/usb',
      managed: true,
      usedForBackups: true,
      label: 'Backups',
    });
  });

  it('counts swap and held devices as in use, and a btrfs mount by its source', () => {
    const { disks } = disksStatus({
      devices: devices().map((d) => (d.name === 'sdb2' ? { ...d, holders: ['dm-3'] } : d)),
      mounts: [...systemMounts, mount('/data', '0:45', '/dev/sdc')],
      swaps: ['sdb1'],
      units: [],
      backupDestination: null,
    });
    const states = Object.fromEntries(
      disks.flatMap((d) => d.partitions).map((p) => [p.device, p.state]),
    );
    expect(states).toMatchObject({ sdb1: 'inUse', sdb2: 'inUse', sdc: 'mounted' });
  });

  it('marks partitions whose UUID another device has too (a copied disk)', () => {
    const { disks } = disksStatus({
      devices: [...devices(), device('sdd', '8:48', { fsType: 'ext4', uuid: 'u1' })],
      mounts: systemMounts,
      swaps: [],
      units: [],
      backupDestination: null,
    });
    const flags = Object.fromEntries(
      disks.flatMap((d) => d.partitions).map((p) => [p.device, p.duplicateUuid]),
    );
    expect(flags).toMatchObject({ sdb1: true, sdd: true, sdb2: false });
  });

  it('lists disks mounted here that aren’t connected now', () => {
    const { disconnected } = disksStatus({
      devices: devices(),
      mounts: systemMounts,
      swaps: [],
      units: [
        { uuid: 'gone', where: '/mnt/old' },
        { uuid: 'u1', where: '/mnt/usb' },
      ],
      backupDestination: '/mnt/old',
    });
    expect(disconnected).toEqual([
      { mountPoint: '/mnt/old', uuid: 'gone', usedForBackups: true },
    ]);
  });
});

describe('systemDisks', () => {
  it('follows device-mapper layers down to the disk (an LVM root)', () => {
    const list = [
      device('sda', '8:0', { partitions: ['sda1', 'sda2'] }),
      device('sda1', '8:1'),
      device('sda2', '8:2', { fsType: 'LVM2_member' }),
      device('dm-0', '254:0', { slaves: ['sda2'] }),
      device('sdb', '8:16'),
    ];
    list[1].disk = 'sda';
    list[2].disk = 'sda';
    expect([...systemDisks(list, [mount('/', '254:0')])]).toEqual(['dm-0', 'sda']);
    const { disks } = disksStatus({
      devices: list,
      mounts: [mount('/', '254:0')],
      swaps: [],
      units: [],
      backupDestination: null,
    });
    // dm-0 is a layer, not a disk of its own.
    expect(disks.map((d) => [d.device, d.system])).toEqual([
      ['sdb', false],
      ['sda', true],
    ]);
  });
});
