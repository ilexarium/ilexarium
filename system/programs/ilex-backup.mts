#!/usr/bin/env -S -i /usr/bin/node
// ilex-backup — runs as root: through sudo (the app) and
// from systemd units (scheduled runs and checks, and "Back up now" runs).
//
//   ilex-backup configure         the plan as JSON on stdin → /etc/ilex/backup.json + timer
//   ilex-backup init              {"destination"} on stdin → creates the repository (+ passphrase)
//   ilex-backup start             {"runId", "itemId"?} on stdin → "Back up now": starts
//                                    ilex-backup-now@<runId>[_<itemId>].service, returns at once
//   ilex-backup run-requested <instance>
//                                    nothing on stdin (ilex-backup-now@.service runs it)
//   ilex-backup run-scheduled     nothing on stdin (ilex-backup.service)
//   ilex-backup check-scheduled   nothing on stdin (ilex-backup-check.service)
//   ilex-backup restore           {"restoreId", "itemId", "archive", "target"} on stdin
//   ilex-backup discard           {"path"} on stdin → deletes a restore's set-aside folder
//   ilex-backup forget            {"itemId"} on stdin → deletes a removed item's archives
//   ilex-backup list              nothing on stdin → each plan item's archives, for "Restore…"
//   ilex-backup passphrase        nothing on stdin → the passphrase, for "Show again"
//
// Backups run as root with Borg, one repository on one disk under /mnt or /media, one archive
// per item per run. The app can only change *what* is backed up, through `configure`, which
// checks everything; this program re-checks it all again before every run, trusting nothing the
// app sent (its checks are its own, written independently of the app's).
//
// Zero dependencies on purpose: only node: built-ins — any package it loaded would run as root.
// `env -i` in the shebang empties the environment before Node starts.
//
// The passphrase never appears in arguments, the environment or output (except `passphrase`'s own
// result): Borg reads it with BORG_PASSCOMMAND from the root-only file.
//
// Output (stdout): `@@phase <phase>`, `@@error code=<code>`, `@@info <text>`, `@@result <json>`,
// and the programs' output, every line prefixed with "> ". Runs, checks and restores also write
// their progress and result to their job file, <state>/jobs/<id>.jsonl (readable by the app's
// group).
//
// Exit codes: 0 done (a run: every item ok, some maybe with warnings) · 2 refused input · 3 busy ·
// 5 failed (a run: some item failed) · 6 setup problem · 143 stopped by SIGTERM.
//
// This file is only the entry: before loading the rest of the program (lib/, backup/ — all of it
// runs as root too), it checks that each of those files belongs to root and that only root can
// change it, or anything above it. Until then, only node: built-ins run.

import { lstatSync, readdirSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = ['lib', 'backup'];

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
const { start } = (await import('./backup/main.mts')) as { start: () => void };
start();
