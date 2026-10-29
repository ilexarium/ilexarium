#!/usr/bin/env -S -i /usr/bin/node
// laris-root — runs as root, started by the signed-in person's own sudo when they unlock it
// (docs/plans/laris_root.md): the helper runs `sudo -S -p '' -- laris-root.mts`, the password the
// one line sudo reads. It does the helper's privileged actions until it's locked, 15 minutes after
// its last request, or when its stdin closes (the helper, and so the Linux session, ended).
//
// One JSON request per line on stdin, one JSON answer per line on stdout, matched by `id` — the
// helper's own requests, in their privileged form:
//
//   {"id":1,"action":"root.run","program":"backup","command":"start","input":"…"}
//   {"id":2,"action":"process.signal","pid":1234,"signal":"TERM","administrator":true}
//   {"id":3,"action":"app.task","project":"music","folder":"…","task":"up","unit":"…","log":"…"}
//   compose.check / volumes.remove ("docker":"sudo"), paths.remove ("administrator":true), touch
//
// The first line it writes is {"laris-root":1}. Whoever unlocked it is root anyway: its checks
// are for correctness, like the root programs'. No shell: every program runs from a fixed path
// with an argument list, in an environment built from scratch.
//
// Zero dependencies on purpose: only node: built-ins. This file is the entry: it checks that the
// modules it loads (root/, helper/) belong to root — or, in development, to the account this file
// belongs to — and that nobody else can change them, before loading them.

import { lstatSync, readdirSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = ['root', 'helper'];

function untrustedModule(): string | null {
  const entryOwner = lstatSync(fileURLToPath(import.meta.url)).uid;
  const unsafe = (path: string): boolean => {
    const stat = lstatSync(path);
    const owner = stat.uid === 0 || stat.uid === entryOwner;
    return stat.isSymbolicLink() || !owner || (stat.mode & 0o022) !== 0;
  };
  for (const folder of MODULES) {
    const dir = join(HERE, folder);
    for (const path of [dir, ...readdirSync(dir).map((name) => join(dir, name))]) {
      if (unsafe(path)) return path;
    }
  }
  // Installed (root-owned): every folder above it too.
  if (entryOwner === 0) {
    for (let parent = HERE; ; parent = dirname(parent)) {
      if (unsafe(parent)) return parent;
      if (parent === '/') break;
    }
  }
  return null;
}

const untrusted = untrustedModule();
if (untrusted) {
  writeSync(1, `${JSON.stringify({ 'laris-root': 1, error: 'setup', path: untrusted })}\n`);
  process.exit(6);
}
const { start } = (await import('./root/main.mts')) as { start: () => void };
start();
