// disk/development.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// Development without systemd (no `systemctlBin` — never in root mode, the configuration requires
// it there): a mount is only pretended, as a line in the pretend host's mountinfo.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMounts } from './devices.mts';
import type { Paths } from './model.mts';

const escapePoint = (where: string) => where.replace(/ /g, '\\040');

export function pretendMount(
  paths: Paths,
  where: string,
  device: { device: string; number: string; fsType: string },
): void {
  const id = 900 + readMounts(paths).length;
  const line = `${id} 1 ${device.number} / ${escapePoint(where)} rw - ${device.fsType} /dev/${device.device} rw\n`;
  appendFileSync(join(paths.host, 'proc/self/mountinfo'), line);
}

export function pretendUnmount(paths: Paths, where: string): void {
  const file = join(paths.host, 'proc/self/mountinfo');
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line && line.split(' ')[4] !== escapePoint(where));
  writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '');
}
