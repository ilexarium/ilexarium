// disk/units.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The systemd mount unit that keeps a disk mounted after a restart — our own file per disk, not a
// line in the shared /etc/fstab (written whole, removed cleanly, never touching anyone else's
// mounts). `nofail`: nothing in the boot waits for it, so a missing disk never delays the boot.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Paths } from './model.mts';

/** A mount's name: its folder under /mnt. */
export const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The first line of every unit this program writes: only those are ever removed. */
export const MARKER = '# Managed by homelab (homelab-disk).';

export const FILESYSTEMS = ['ext4', 'xfs', 'btrfs', 'exfat'];

/**
 * The unit's file name: systemd names a mount unit after its folder — /mnt/<name> is
 * `mnt-<name>.mount`, with `-` written `\x2d` (`systemd-escape --path`). Names are checked first,
 * so `-` is the only character to escape.
 */
export function unitName(name: string): string {
  return `mnt-${name.replace(/-/g, '\\x2d')}.mount`;
}

export function unitPath(paths: Paths, name: string): string {
  return join(paths.unitDir, unitName(name));
}

export function unitContent(name: string, uuid: string, fsType: string, where: string): string {
  return [
    MARKER,
    '# It is not in /etc/fstab: `systemctl list-units --type=mount` lists it.',
    '[Unit]',
    `Description=homelab disk ${name}`,
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
