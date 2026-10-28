// disk/units.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The systemd mount unit that keeps a disk mounted after a restart — our own file per disk, not a
// line in the shared /etc/fstab (written whole, removed cleanly, never touching anyone else's
// mounts). `nofail`: nothing in the boot waits for it, so a missing disk never delays the boot.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Paths } from './model.mts';

/**
 * Never a mount point, nor inside one of these: the system's own folders. Anywhere else is the
 * person's choice (their sudo, their machine) — /mnt/<name> by default.
 */
export const SYSTEM_FOLDERS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/opt/laris',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var',
];

/** The first line of every unit this program writes: only those are ever removed. */
export const MARKER = '# Managed by laris (laris-disk).';

export const FILESYSTEMS = ['ext4', 'xfs', 'btrfs', 'exfat'];

/**
 * The unit's file name: systemd names a mount unit after its folder, escaped like
 * `systemd-escape --path` — "/" between names becomes "-", anything but letters, digits, ":",
 * "_" and "." (not first) becomes `\xNN` per byte. /mnt/my-disk is `mnt-my\x2ddisk.mount`.
 */
export function unitName(where: string): string {
  const escaped = where
    .slice(1)
    .split('/')
    .map((part) =>
      [...Buffer.from(part, 'utf8')]
        .map((byte, i) => {
          const char = String.fromCharCode(byte);
          const plain = /[A-Za-z0-9:_]/.test(char) || (char === '.' && i > 0);
          return plain ? char : `\\x${byte.toString(16).padStart(2, '0')}`;
        })
        .join(''),
    )
    .join('-');
  return `${escaped}.mount`;
}

export function unitPath(paths: Paths, where: string): string {
  return join(paths.unitDir, unitName(where));
}

export function unitContent(uuid: string, fsType: string, where: string): string {
  return [
    MARKER,
    '# It is not in /etc/fstab: `systemctl list-units --type=mount` lists it.',
    '[Unit]',
    `Description=laris disk at ${where}`,
    '',
    '[Mount]',
    `What=/dev/disk/by-uuid/${uuid}`,
    `Where=${where}`,
    `Type=${fsType}`,
    'Options=nofail,nodev,nosuid,noatime',
    'TimeoutSec=30',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/** Whether the unit file is one this program wrote. */
export function isOurs(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').startsWith(`${MARKER}\n`);
  } catch {
    return false;
  }
}
