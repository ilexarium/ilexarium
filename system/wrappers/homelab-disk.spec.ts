// Tests for the disk wrapper (homelab-disk.mts) — run in development mode (not root), against a
// pretend host (sys, run/udev, dev, proc under a temporary folder) and a fake `systemctl` that
// mounts by writing the pretend mountinfo (testing/fake-disk-systemctl.cjs). Run by the server's
// unit tests.
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = fileURLToPath(new URL('./homelab-disk.mts', import.meta.url));
const FAKE = fileURLToPath(new URL('./testing/fake-disk-systemctl.cjs', import.meta.url));

const EXT4 = '0b6e6e2c-1111-4a6e-9f0e-6c2c8b3d1a01';
const BTRFS = '5c1f2a3b-2222-4b7c-8d9e-0f1a2b3c4d5e';
const ROOT = '9e8d7c6b-3333-4a59-8b7a-6c5d4e3f2a10';
const SPARE = '9e8d7c6b-4444-4a59-8b7a-6c5d4e3f2a11';
const LVM_ROOT = '7a7a7a7a-5555-4b7c-8d9e-0f1a2b3c4d5e';
const EXFAT = 'AB12-CD34';

let dir: string;
let host: string;

interface Partition {
  name: string;
  number: string;
  fsType?: string;
  uuid?: string;
  holders?: string[];
}

/** A disk in the pretend /sys, udev database and /dev/disk/by-uuid. */
function addDisk(name: string, number: string, partitions: Partition[], own?: Partition) {
  const block = join(host, 'sys/class/block');
  mkdirSync(join(block, name), { recursive: true });
  writeFileSync(join(block, name, 'dev'), `${number}\n`);
  const describe = (p: Partition, folder: string) => {
    for (const holder of p.holders ?? [])
      mkdirSync(join(folder, 'holders', holder), { recursive: true });
    const lines = [
      ...(p.fsType ? [`E:ID_FS_TYPE=${p.fsType}`] : []),
      ...(p.uuid ? [`E:ID_FS_UUID=${p.uuid}`] : []),
    ];
    writeFileSync(join(host, 'run/udev/data', `b${p.number}`), `${lines.join('\n')}\n`);
    if (p.uuid) symlinkSync(`../../${p.name}`, join(host, 'dev/disk/by-uuid', p.uuid));
  };
  if (own) describe(own, join(block, name));
  for (const p of partitions) {
    const folder = join(block, name, p.name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'dev'), `${p.number}\n`);
    writeFileSync(join(folder, 'partition'), '1\n');
    symlinkSync(`${name}/${p.name}`, join(block, p.name));
    describe(p, folder);
  }
}

function writeConfig(systemctl: boolean) {
  const disk = {
    ...(systemctl ? { systemctlBin: join(dir, 'systemctl') } : {}),
    dev: {
      root: host,
      mountRoot: join(dir, 'mnt'),
      unitDir: join(dir, 'units'),
      backupPlan: join(dir, 'backup.json'),
    },
  };
  writeFileSync(join(dir, 'wrappers.json'), JSON.stringify({ disk }));
}

const mountinfo = () => readFileSync(join(host, 'proc/self/mountinfo'), 'utf8');
const mountedAt = (where: string) =>
  mountinfo()
    .split('\n')
    .some((l) => l.split(' ')[4] === where);

interface Run {
  code: number | null;
  out: string;
  result: Record<string, any> | null;
}

function wrapper(args: string[], input: unknown = ''): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRAPPER, ...args], {
      env: { HOMELAB_WRAPPER_CONFIG: join(dir, 'wrappers.json') },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    child.on('close', (code) => {
      const line = out.split('\n').findLast((l) => l.startsWith('@@result '));
      resolve({ code, out, result: line ? JSON.parse(line.slice(9)) : null });
    });
  });
}

const mount = (uuid: string, name: string) => wrapper(['mount'], { uuid, name });
const unmount = (name: string) => wrapper(['unmount'], { name });

function expectRefused(run: Run, code: string) {
  expect(run.out).toContain(`@@error code=${code}`);
  expect(run.code).not.toBe(0);
}

const calls = (): string[][] => {
  const file = join(dir, 'systemctl-calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { args: string[] }).args);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'homelab-disk-'));
  host = join(dir, 'host');
  for (const folder of ['sys/class/block', 'run/udev/data', 'dev/disk/by-uuid', 'proc/self']) {
    mkdirSync(join(host, folder), { recursive: true });
  }
  mkdirSync(join(dir, 'mnt'));
  // The system disk: /boot and / on vda, and a spare partition on it.
  addDisk('vda', '253:0', [
    { name: 'vda1', number: '253:1', fsType: 'vfat', uuid: 'B007-0001' },
    { name: 'vda2', number: '253:2', fsType: 'ext4', uuid: ROOT },
    { name: 'vda3', number: '253:3', fsType: 'ext4', uuid: SPARE },
  ]);
  // A USB disk: ext4, exFAT, NTFS, and an ext4 another device holds.
  addDisk('sdb', '8:16', [
    { name: 'sdb1', number: '8:17', fsType: 'ext4', uuid: EXT4 },
    { name: 'sdb2', number: '8:18', fsType: 'exfat', uuid: EXFAT },
    { name: 'sdb3', number: '8:19', fsType: 'ntfs', uuid: '0123456789ABCDEF' },
    { name: 'sdb4', number: '8:20', fsType: 'ext4', uuid: 'aaaa-held', holders: ['dm-5'] },
  ]);
  // A disk formatted whole (no partitions): btrfs.
  addDisk('sdc', '8:32', [], { name: 'sdc', number: '8:32', fsType: 'btrfs', uuid: BTRFS });
  writeFileSync(
    join(host, 'proc/self/mountinfo'),
    [
      '21 1 253:2 / / rw,relatime - ext4 /dev/vda2 rw',
      '22 21 253:1 / /boot rw,relatime - vfat /dev/vda1 rw',
      '23 21 0:22 / /proc rw - proc proc rw',
      '',
    ].join('\n'),
  );
  writeFileSync(join(host, 'proc/swaps'), 'Filename Type Size Used Priority\n');
  writeFileSync(join(dir, 'systemctl'), `#!${process.execPath}\n${readFileSync(FAKE, 'utf8')}`, {
    mode: 0o755,
  });
  writeConfig(true);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('homelab-disk', () => {
  it('starts with an empty environment, like the other wrappers', () => {
    expect(readFileSync(WRAPPER, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env -S -i /usr/bin/node');
  });

  it('takes exactly one known action, and only the keys it expects', async () => {
    expectRefused(await wrapper(['format']), 'invalid_request');
    expectRefused(await wrapper(['mount', 'x']), 'invalid_request');
    expectRefused(
      await wrapper(['mount'], { uuid: EXT4, name: 'usb', options: 'exec' }),
      'invalid_request',
    );
    expectRefused(await wrapper(['mount'], 'not json'), 'invalid_request');
  });

  describe('mount', () => {
    it('mounts at /mnt/<name> with its own unit, kept after a restart, nothing waiting for it', async () => {
      const run = await mount(EXT4, 'backup-disk');
      expect(run.code).toBe(0);
      const where = join(dir, 'mnt', 'backup-disk');
      expect(run.result).toEqual({ mountPoint: where });
      expect(mountedAt(where)).toBe(true);
      // `-` escaped the way systemd names mount units.
      const unit = join(dir, 'units', 'mnt-backup\\x2ddisk.mount');
      expect(readFileSync(unit, 'utf8')).toBe(
        [
          '# Managed by homelab (homelab-disk).',
          '# It is not in /etc/fstab: `systemctl list-units --type=mount` lists it.',
          '[Unit]',
          'Description=homelab disk backup-disk',
          '',
          '[Mount]',
          `What=/dev/disk/by-uuid/${EXT4}`,
          `Where=${where}`,
          'Type=ext4',
          'Options=nofail,nodev,nosuid,noatime',
          'TimeoutSec=30',
          '',
          '[Install]',
          'WantedBy=multi-user.target',
          '',
        ].join('\n'),
      );
      expect(statSync(unit).mode & 0o777).toBe(0o644);
      expect(statSync(where).mode & 0o777).toBe(0o755);
      expect(calls()).toEqual([
        ['daemon-reload'],
        ['enable', '--now', 'mnt-backup\\x2ddisk.mount'],
      ]);
    });

    it('mounts exFAT, and a disk formatted whole (btrfs)', async () => {
      expect((await mount(EXFAT, 'stick')).code).toBe(0);
      expect((await mount(BTRFS, 'big')).code).toBe(0);
      expect(readFileSync(join(dir, 'units', 'mnt-big.mount'), 'utf8')).toContain('Type=btrfs');
    });

    it('refuses every partition of the disk the system runs from — mounted or not', async () => {
      expectRefused(await mount(SPARE, 'spare'), 'system_disk');
      expect(calls()).toEqual([]);
    });

    it('refuses the system disk under a device-mapper layer (LVM root)', async () => {
      // The root filesystem is dm-0, on sdd1; sdd2 is on the same disk, sde is a different one.
      addDisk('sdd', '8:48', [
        { name: 'sdd1', number: '8:49', fsType: 'LVM2_member' },
        { name: 'sdd2', number: '8:50', fsType: 'ext4', uuid: 'dddd-on-system' },
      ]);
      addDisk('sde', '8:64', [{ name: 'sde1', number: '8:65', fsType: 'ext4', uuid: LVM_ROOT }]);
      mkdirSync(join(host, 'sys/class/block/dm-0/slaves/sdd1'), { recursive: true });
      writeFileSync(join(host, 'sys/class/block/dm-0/dev'), '254:0\n');
      writeFileSync(
        join(host, 'proc/self/mountinfo'),
        '21 1 254:0 / / rw - ext4 /dev/mapper/vg-root rw\n',
      );
      expectRefused(await mount('dddd-on-system', 'other'), 'system_disk');
      expect((await mount(LVM_ROOT, 'free')).code).toBe(0);
    });

    it('refuses what is mounted, held by another device, partitioned, or not supported', async () => {
      writeFileSync(
        join(host, 'proc/self/mountinfo'),
        `${mountinfo()}30 21 8:17 / /media/someone/USB rw - ext4 /dev/sdb1 rw\n`,
      );
      expectRefused(await mount(EXT4, 'usb'), 'disk_in_use');
      expectRefused(await mount('aaaa-held', 'held'), 'disk_in_use');
      expectRefused(await mount('0123456789ABCDEF', 'windows'), 'unsupported_filesystem');
      expectRefused(await mount('no-such-uuid', 'nothing'), 'disk_not_found');
      expect(calls()).toEqual([]);
    });

    it('refuses a UUID another device has too (a copied disk)', async () => {
      // The clone: udev's link points at one of them only; both carry the UUID.
      addDisk('sdg', '8:96', [{ name: 'sdg1', number: '8:97', fsType: 'ext4' }]);
      writeFileSync(
        join(host, 'run/udev/data', 'b8:97'),
        `E:ID_FS_TYPE=ext4\nE:ID_FS_UUID=${EXT4}\n`,
      );
      expectRefused(await mount(EXT4, 'usb'), 'duplicate_uuid');
      expect(calls()).toEqual([]);
    });

    it('refuses swap in use', async () => {
      writeFileSync(
        join(host, 'proc/swaps'),
        'Filename Type Size Used Priority\n/dev/sdb1 partition 1 0 -2\n',
      );
      expectRefused(await mount(EXT4, 'usb'), 'disk_in_use');
    });

    it('refuses a btrfs disk already mounted (its mounts show an anonymous device number)', async () => {
      writeFileSync(
        join(host, 'proc/self/mountinfo'),
        `${mountinfo()}31 21 0:45 / /data rw - btrfs /dev/sdc rw\n`,
      );
      expectRefused(await mount(BTRFS, 'big'), 'disk_in_use');
    });

    it('checks the name and the UUID: their form, and a folder that is free', async () => {
      for (const name of ['', 'Big', '../etc', 'a/b', '-x', 'a'.repeat(33), 'x y']) {
        expectRefused(await mount(EXT4, name), 'invalid_request');
      }
      for (const uuid of ['', '../sdb1', 'a/b', 'x'.repeat(65)]) {
        expectRefused(await mount(uuid, 'usb'), 'invalid_request');
      }
      mkdirSync(join(dir, 'mnt', 'full'));
      writeFileSync(join(dir, 'mnt', 'full', 'file'), 'x');
      expectRefused(await mount(EXT4, 'full'), 'name_taken');
      symlinkSync('/etc', join(dir, 'mnt', 'link'));
      expectRefused(await mount(EXT4, 'link'), 'name_taken');
      writeFileSync(join(dir, 'mnt', 'file'), 'x');
      expectRefused(await mount(EXT4, 'file'), 'name_taken');
      expect(calls()).toEqual([]);
    });

    it('uses an empty folder that is already there', async () => {
      mkdirSync(join(dir, 'mnt', 'usb'));
      expect((await mount(EXT4, 'usb')).code).toBe(0);
    });

    it('refuses a name whose unit exists', async () => {
      mkdirSync(join(dir, 'units'));
      writeFileSync(join(dir, 'units', 'mnt-usb.mount'), '[Mount]\n');
      expectRefused(await mount(EXT4, 'usb'), 'name_taken');
    });

    it('undoes everything when systemd fails to mount it', async () => {
      writeFileSync(join(dir, 'fail-enable'), '');
      const run = await mount(EXT4, 'usb');
      expectRefused(run, 'mount_failed');
      expect(run.out).toContain('@@info Job for x.mount failed');
      expect(existsSync(join(dir, 'units', 'mnt-usb.mount'))).toBe(false);
      expect(existsSync(join(dir, 'mnt', 'usb'))).toBe(false);
      expect(mountedAt(join(dir, 'mnt', 'usb'))).toBe(false);
      expect(calls().at(-1)).toEqual(['daemon-reload']);
    });

    it('waits for nobody: refused while another operation holds the lock', async () => {
      mkdirSync(join(dir, 'units'), { recursive: true });
      writeFileSync(`${join(dir, 'units')}.lock`, String(process.pid));
      expectRefused(await mount(EXT4, 'usb'), 'busy');
    });

    it('only pretends in development without systemd', async () => {
      writeConfig(false);
      expect((await mount(EXT4, 'usb')).code).toBe(0);
      expect(mountedAt(join(dir, 'mnt', 'usb'))).toBe(true);
      expect((await unmount('usb')).code).toBe(0);
      expect(mountedAt(join(dir, 'mnt', 'usb'))).toBe(false);
      expect(existsSync(join(dir, 'mnt', 'usb'))).toBe(false);
    });
  });

  describe('unmount', () => {
    it('unmounts a disk it mounted, removing its unit and its empty folder', async () => {
      await mount(EXT4, 'usb');
      const run = await unmount('usb');
      expect(run.code).toBe(0);
      expect(mountedAt(join(dir, 'mnt', 'usb'))).toBe(false);
      expect(existsSync(join(dir, 'units', 'mnt-usb.mount'))).toBe(false);
      expect(existsSync(join(dir, 'mnt', 'usb'))).toBe(false);
      expect(calls().slice(-2)).toEqual([['disable', '--now', 'mnt-usb.mount'], ['daemon-reload']]);
    });

    it('says busy while files on it are open, and keeps it as it is — enabled too', async () => {
      await mount(EXT4, 'usb');
      writeFileSync(join(dir, 'busy'), '');
      expectRefused(await unmount('usb'), 'disk_busy');
      expect(existsSync(join(dir, 'units', 'mnt-usb.mount'))).toBe(true);
      // `disable --now` disabled it before failing to stop it: enabled again.
      expect(calls().slice(-2)).toEqual([
        ['disable', '--now', 'mnt-usb.mount'],
        ['enable', 'mnt-usb.mount'],
      ]);
    });

    it('refuses the disk the backups are kept on', async () => {
      await mount(EXT4, 'usb');
      writeFileSync(
        join(dir, 'backup.json'),
        JSON.stringify({ destination: join(dir, 'mnt', 'usb') }),
      );
      expectRefused(await unmount('usb'), 'used_for_backups');
      expect(mountedAt(join(dir, 'mnt', 'usb'))).toBe(true);
    });

    it('waits for nobody: refused while another operation holds the lock', async () => {
      await mount(EXT4, 'usb');
      writeFileSync(`${join(dir, 'units')}.lock`, String(process.pid));
      expectRefused(await unmount('usb'), 'busy');
      expect(mountedAt(join(dir, 'mnt', 'usb'))).toBe(true);
    });

    it('touches only units it wrote', async () => {
      mkdirSync(join(dir, 'units'));
      writeFileSync(join(dir, 'units', 'mnt-data.mount'), '[Mount]\nWhat=/dev/sda1\n');
      expectRefused(await unmount('data'), 'not_managed');
      expectRefused(await unmount('nothing'), 'not_managed');
      expectRefused(await unmount('../x'), 'invalid_request');
      expect(existsSync(join(dir, 'units', 'mnt-data.mount'))).toBe(true);
    });

    it('removes a disk that is no longer connected (its unit only)', async () => {
      await mount(EXT4, 'usb');
      rmSync(join(host, 'dev/disk/by-uuid', EXT4));
      expect((await unmount('usb')).code).toBe(0);
      expect(existsSync(join(dir, 'units', 'mnt-usb.mount'))).toBe(false);
    });
  });
});
