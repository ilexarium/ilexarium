// disk/main.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The actions, and which one runs.

import { loadConfig, pathsFor } from './config.mts';
import { mount, unmount } from './mount.mts';
import { emit, finish, Refusal } from '../lib/output.mts';
import { readInput } from '../lib/startup.mts';

export const ACTIONS = new Set(['mount', 'unmount']);

const MAX_INPUT_BYTES = 4 * 1024;

export function checkStartup(): string {
  if (process.env['NODE_OPTIONS'] !== undefined || process.execArgv.length > 0) {
    throw new Refusal('invalid_request', 'Node was started with options', 6);
  }
  const args = process.argv.slice(2);
  if (args.length !== 1 || !ACTIONS.has(args[0])) {
    throw new Refusal('invalid_request', `usage: homelab-disk ${[...ACTIONS].join('|')}`);
  }
  return args[0];
}

export async function main(): Promise<number> {
  process.umask(0o077);
  const action = checkStartup();
  const config = loadConfig();
  const paths = pathsFor(config);
  const input = readInput(MAX_INPUT_BYTES, 'invalid_request');
  switch (action) {
    case 'mount': {
      const mountPoint = await mount(config, paths, input);
      emit(`@@result ${JSON.stringify({ mountPoint })}`);
      return 0;
    }
    case 'unmount':
      await unmount(config, paths, input);
      emit('@@phase done');
      return 0;
  }
  throw new Refusal('invalid_request', 'unknown action');
}

/** Called by the entry (homelab-disk.mts) once it checked these modules. */
export function start(): void {
  finish(main);
}
