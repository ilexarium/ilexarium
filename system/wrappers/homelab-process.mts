#!/usr/bin/env -S -i /usr/bin/node
// homelab-process — REVIEW-REQUIRED (system/CLAUDE.md). Runs as root, through sudo (the app).
//
//   homelab-process signal   {"pid", "startTicks", "signal"} on stdin → sends SIGTERM or SIGKILL
//                            to a person's process, as that person
//
// Only a person's process: its owner's uids all at least `minUid` (1000) and none the app's own;
// never PID 1, a kernel thread, a process in a container (a service is stopped on the Containers
// page), root's or a system account's. PID and start time (clock ticks since boot, field 22 of
// /proc/<pid>/stat) must both match: a PID used again by another process is refused. Everything
// is read again here from /proc — nothing the app says about the process is trusted. Before the
// signal it takes on the owner's uid and gid, so the kernel only lets it signal that person's
// processes: it never signals anything as root. Design: docs/plans/process_list.md.
//
// Zero dependencies on purpose: only node: built-ins — any package it loaded would run as root.
// `env -i` in the shebang empties the environment before Node starts.
//
// Output (stdout): `@@error code=<code>`, `@@info <text>`, `@@result <json>`.
//
// Exit codes: 0 done · 2 refused input · 5 failed · 6 setup problem.
//
// This file is only the entry: before loading the rest of the program (lib/, process/ — all of
// it runs as root too), it checks that each of those files belongs to root and that only root can
// change it, or anything above it. Until then, only node: built-ins run.

import { lstatSync, readdirSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = ['lib', 'process'];

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
const { start } = (await import('./process/main.mts')) as { start: () => void };
start();
