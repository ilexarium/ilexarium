import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  ProgramBackupConfig,
  ProgramConfig,
  ProgramDiskConfig,
} from './root-programs.model.js';

// Development only (never production): pretend disks for the disk wrapper — see
// WrapperConfigService, which adds them to a development config that has none.

/**
 * Development disks: a pretend host (its /sys, udev database, /dev/disk/by-uuid and mountinfo)
 * with a system disk and a few USB disks, the disk wrapper pretending its mounts (no systemd).
 * The backups' pretend mount table moves into it, so a disk mounted here is a backup disk too.
 */
export async function withDevelopmentDisks(
  config: ProgramConfig,
  backup: ProgramBackupConfig,
): Promise<ProgramConfig> {
  // Beside the backups' development folder (the dev and e2e configs share it, like that one).
  const dir = resolve(dirname(backup.dev!.dir), 'disk');
  const host = resolve(dir, 'host');
  for (const folder of ['sys/class/block', 'run/udev/data', 'dev/disk/by-uuid', 'proc/self']) {
    await mkdir(resolve(host, folder), { recursive: true });
  }
  const disks: {
    disk: string;
    number: string;
    model: string;
    parts: [string, string, string, string, string][];
  }[] = [
    {
      disk: 'vda',
      number: '253:0',
      model: 'System disk',
      parts: [
        ['vda1', '253:1', 'vfat', 'B007-0001', 'BOOT'],
        ['vda2', '253:2', 'ext4', '6f1e2d3c-0000-4000-8000-000000000001', 'root'],
      ],
    },
    {
      disk: 'sdz',
      number: '8:240',
      model: 'USB Disk',
      parts: [['sdz1', '8:241', 'ext4', '6f1e2d3c-0000-4000-8000-000000000002', 'Backups']],
    },
    {
      disk: 'sdy',
      number: '8:224',
      model: 'USB Disk',
      parts: [['sdy1', '8:225', 'ext4', '6f1e2d3c-0000-4000-8000-000000000003', 'Old backups']],
    },
    {
      disk: 'sdx',
      number: '8:208',
      model: 'Portable SSD',
      parts: [
        ['sdx1', '8:209', 'exfat', '4E21-9A07', 'Photos'],
        ['sdx2', '8:210', 'ntfs', '01D9A1B2C3D4E5F6', 'Windows'],
      ],
    },
  ];
  const block = resolve(host, 'sys/class/block');
  const describe = async (
    folder: string,
    [name, number, fsType, uuid, label]: [string, string, string, string, string],
  ) => {
    await mkdir(folder, { recursive: true });
    await writeFile(resolve(folder, 'dev'), `${number}\n`);
    await writeFile(resolve(folder, 'size'), `${250_000_000}\n`);
    await writeFile(
      resolve(host, 'run/udev/data', `b${number}`),
      `E:ID_FS_TYPE=${fsType}\nE:ID_FS_UUID=${uuid}\nE:ID_FS_LABEL=${label}\n`,
    );
    await symlink(`../../${name}`, resolve(host, 'dev/disk/by-uuid', uuid)).catch(() => undefined);
  };
  for (const { disk, number, model, parts } of disks) {
    const folder = resolve(block, disk);
    await mkdir(resolve(folder, 'device'), { recursive: true });
    await writeFile(resolve(folder, 'dev'), `${number}\n`);
    await writeFile(resolve(folder, 'size'), `${1_000_000_000}\n`);
    await writeFile(resolve(folder, 'removable'), disk === 'vda' ? '0\n' : '1\n');
    await writeFile(resolve(folder, 'device/model'), `${model}\n`);
    for (const part of parts) {
      await describe(resolve(folder, part[0]), part);
      await writeFile(resolve(folder, part[0], 'partition'), '1\n');
      await symlink(`${disk}/${part[0]}`, resolve(block, part[0])).catch(() => undefined);
    }
  }
  // A disk formatted whole.
  await describe(resolve(block, 'sdw'), [
    'sdw',
    '8:192',
    'btrfs',
    '6f1e2d3c-0000-4000-8000-000000000004',
    'Archive',
  ]);
  await writeFile(resolve(block, 'sdw', 'removable'), '1\n');
  const backupMounts = existsSync(backup.dev!.mountInfo)
    ? await readFile(backup.dev!.mountInfo, 'utf8')
    : '';
  const mountInfo = resolve(host, 'proc/self/mountinfo');
  await writeFile(
    mountInfo,
    `21 1 253:2 / / rw - ext4 /dev/vda2 rw\n22 21 253:1 / /boot rw - vfat /dev/vda1 rw\n${backupMounts}`,
  );
  await writeFile(resolve(host, 'proc/swaps'), 'Filename Type Size Used Priority\n');
  // Mount points live under the pretend root: its usual parent folders exist, like a machine's.
  const mountRoot = backup.dev!.destinationRoots[0];
  for (const folder of ['mnt', 'media'])
    await mkdir(resolve(mountRoot, folder), { recursive: true });
  const disk: ProgramDiskConfig = {
    dev: {
      root: host,
      mountRoot,
      unitDir: resolve(dir, 'units'),
      backupPlan: resolve(backup.dev!.dir, 'backup.json'),
    },
  };
  return { ...config, backup: { ...backup, dev: { ...backup.dev!, mountInfo } }, disk };
}
