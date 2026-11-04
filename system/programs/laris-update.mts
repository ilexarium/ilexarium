#!/usr/bin/env -S -i /usr/bin/node
// laris-update — runs as root: `start` through the person's sudo (laris-root), `run` from its
// unit. Design: docs/plans/install_and_update.md.
//
//   laris-update start             {"updateId", "version"} on stdin → checks it, then starts
//                                    laris-update@<updateId>.service and returns at once
//   laris-update run <updateId>    nothing on stdin (laris-update@.service runs it): fetches the
//                                    version's manifest and signature from RELEASE_URL
//                                    (/etc/laris/release.env), checks them with the installed key
//                                    (/etc/laris/release.pub), downloads the archive (size and
//                                    SHA-256 from the manifest), runs its install.sh --update, and
//                                    puts the kept version back if the new one doesn't come up
//
// Only the version comes from the app — never an address or a file. Progress and result go to
// /var/lib/laris/updates/<updateId>.jsonl (readable by the app's group).
//
// Zero dependencies on purpose: only node: built-ins — any package it loaded would run as root.
// `env -i` in the shebang empties the environment before Node starts.
//
// Output (stdout): `@@phase <phase>`, `@@error code=<code>`, `@@info <text>`, `@@result <json>`,
// and the installer's output, every line prefixed with "> ".
//
// Exit codes: 0 done · 2 refused input · 3 busy · 5 failed (rolled back or not) · 6 setup problem.
//
// This file is only the entry: before loading the rest of the program (lib/, update/ — all of it
// runs as root too), it checks that each of those files belongs to root and that only root can
// change it, or anything above it. Until then, only node: built-ins run.

import { lstatSync, readdirSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = ['lib', 'update'];

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
// Every module is loaded now, before the install replaces /opt/laris/libexec: the rollback
// runs the code that was checked here.
const { startProgram } = (await import('./update/main.mts')) as { startProgram: () => void };
startProgram();
