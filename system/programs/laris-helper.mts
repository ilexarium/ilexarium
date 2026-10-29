#!/usr/bin/env -S -i /usr/bin/node
// laris-helper — runs as the signed-in person, not root: the server starts it over that person's
// SSH session, in its own channel, for the session's life (docs/plans/acting_as_you.md, "The
// helper").
//
// One JSON request per line on stdin, one JSON answer per line on stdout, matched by `id`:
//
//   {"id":1,"action":"hello"}                                  → {"uid","user","home"}
//   {"id":2,"action":"sudo.unlock","password":"…"}             → starts laris-root through sudo -S
//   {"id":3,"action":"process.signal","pid":1234,"signal":"TERM","administrator":false}
//
// Answers: {"id","ok":true,…} or {"id","ok":false,"error":"<code>"}. The first line it writes is
// {"laris-helper":1}: requests are sent only after it (lines before it are the login's noise).
// {"event":"sudo.locked"}: laris-root ended on its own (idle).
//
// Root is laris-root (docs/plans/laris_root.md), started by this account's sudo with the password
// as the one line sudo reads, running for the unlock: privileged requests are forwarded to it,
// and answer sudo_required while it isn't running. It ends with this program ("Lock now" starts
// a new helper). This program never keeps a password.
// It has the person's rights and nothing more: its checks are for correctness, not a boundary.
// No shell: every program runs from a fixed path with an argument list.
//
// Zero dependencies on purpose (like the root programs): only node: built-ins. This file is the
// entry: it checks that the modules it loads (helper/) belong to root — or, in development, to
// the account this file belongs to — and that nobody else can change them, before loading them.

import { lstatSync, readdirSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = ['helper'];

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
  writeSync(1, `${JSON.stringify({ 'laris-helper': 1, error: 'setup', path: untrusted })}\n`);
  process.exit(6);
}
const { start } = (await import('./helper/main.mts')) as { start: () => void };
start();
