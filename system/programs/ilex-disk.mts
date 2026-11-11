#!/usr/bin/env -S -i /usr/bin/node
// ilex-disk — runs as root, through sudo (the app).
//
//   ilex-disk mount     {"uuid", "name"} on stdin → mounts the disk at /mnt/<name>, kept after
//                          a restart (its own systemd unit, mnt-<name>.mount — not /etc/fstab)
//   ilex-disk unmount   {"name"} on stdin → unmounts a disk this program mounted; removes its
//                          unit, and its folder if empty
//
// Every partition of the disk the system runs from is refused, and anything mounted, swap, part of
// RAID/LVM/encryption, or not ext4/xfs/btrfs/exFAT. Everything is read again here, from /sys,
// udev's database and mountinfo — nothing the app sends is trusted. `nofail`: nothing in the boot
// waits for these mounts, so a missing disk never delays the boot. A disk the backups are kept on
// isn't unmounted. Design: docs/plans/disk_management.md.
//
// Zero dependencies on purpose: only node: built-ins — any package it loaded would run as root.
// `env -i` in the shebang empties the environment before Node starts.
//
// Output (stdout): `@@phase <phase>`, `@@error code=<code>`, `@@info <text>`, `@@result <json>`,
// and systemctl's output, every line prefixed with "> ".
//
// Exit codes: 0 done · 2 refused input · 3 busy (another operation; `disk_busy`: files open on it) ·
// 5 failed · 6 setup problem.
//
// This file is only the entry: before loading the rest of the program (lib/, disk/ — all of it
// runs as root too), it checks that each of those files belongs to root and that only root can
// change it, or anything above it. Until then, only node: built-ins run.

import { lstatSync, readdirSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = ['lib', 'disk'];

/**
 * Every module file and its folder: no symlinks, writable by nobody but its owner, owned by root
 * — in development (not root), by root or this user, and only the module folders themselves are
 * checked (the repository may be anywhere). In root mode every folder above them too.
 */
function untrustedModule(): string | null {
  const me = process.getuid?.() ?? 0;
  const root = me === 0;
  const unsafe = (path: string): boolean => {
    const stat = lstatSync(path);
    const owner = stat.uid === 0 || (!root && stat.uid === me);
    return stat.isSymbolicLink() || !owner || (stat.mode & 0o022) !== 0;
  };
  for (const folder of MODULES) {
    const dir = join(HERE, folder);
    for (const path of [dir, ...readdirSync(dir).map((name) => join(dir, name))]) {
      if (unsafe(path)) return path;
    }
  }
  if (root) {
    for (let parent = HERE; ; parent = dirname(parent)) {
      if (unsafe(parent)) return parent;
      if (parent === '/') break;
    }
  }
  return null;
}

const untrusted = untrustedModule();
if (untrusted) {
  writeSync(1, `@@info ${untrusted} must belong to root and be writable only by root\n`);
  writeSync(1, '@@error code=setup\n');
  process.exit(6);
}
const { start } = (await import('./disk/main.mts')) as { start: () => void };
start();
