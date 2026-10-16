#!/usr/bin/env -S -i /usr/bin/node
// homelab-compose — REVIEW-REQUIRED (system/CLAUDE.md). Runs as root through sudo.
//
//   homelab-compose up   <catalog id>    values as JSON on stdin
//   homelab-compose down <catalog id>    nothing on stdin
//
// The app (user "homelab") may run this one program as root, nothing else. It treats the app as
// a possible attacker: it deploys only reviewed recipes from the root-owned catalog, fills their
// ${KEY} blanks only with values that pass its own checks (written independently of the app's),
// checks Compose's final rendered config against the policy, and runs Compose in one fixed way.
// Design: docs/plans/service_deploys.md (decisions 1, 2, 5, 6).
//
// Zero dependencies on purpose: only node: built-ins — any package it loaded would run as root.
// `env -i` in the shebang empties the environment before Node starts (NODE_OPTIONS could
// otherwise load code); sudo's env_reset does the same.
//
// Output (stdout): its own markers — `@@phase <phase>`, `@@error code=<code>[ field=<KEY>]`,
// `@@info <text>` — and Compose's output, every line prefixed with "> ", so only this program
// can write a line starting with "@@".
//
// Exit codes: 0 done · 2 refused input · 3 busy · 4 policy violation · 5 Compose failed ·
// 6 setup problem (config, catalog) · 143 stopped by SIGTERM.
//
// This file is only the entry: before loading the rest of the program (lib/, compose/ — all of it
// runs as root too), it checks that each of those files belongs to root and that only root can
// change it, or anything above it. Until then, only node: built-ins run.

import { lstatSync, readdirSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = ['lib', 'compose'];

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
const { start } = (await import('./compose/main.mts')) as { start: () => void };
start();
