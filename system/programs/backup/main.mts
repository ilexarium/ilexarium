// backup/main.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The actions, and which one runs.

import { randomUUID } from 'node:crypto';
import { check } from './check.mts';
import { loadConfig, pathsFor } from './config.mts';
import { configure } from './configure.mts';
import { init } from './init.mts';
import { MAX_INPUT_BYTES, requireNoInput } from './input.mts';
import { forget, passphrase } from './maintenance.mts';
import { stopping, stopRunning } from './programs.mts';
import { discard, restoreRun, restoreStart } from './restore.mts';
import { run } from './run.mts';
import { parseInstance, start as startRun } from './start.mts';
import { emit, finish, Refusal } from '../lib/output.mts';
import { readInput } from '../lib/startup.mts';

export const ACTIONS = new Set([
  'configure',
  'init',
  'start',
  'run-requested',
  'run-scheduled',
  'check-scheduled',
  'restore-start',
  'restore-run',
  'discard',
  'forget',
  'passphrase',
]);

/** The action, and for `run-requested` and `restore-run` their unit instance (the only actions with an argument). */
export function checkStartup(): { action: string; instance: string | null } {
  if (process.env['NODE_OPTIONS'] !== undefined || process.execArgv.length > 0) {
    throw new Refusal('invalid_request', 'Node was started with options', 6);
  }
  const args = process.argv.slice(2);
  const expected = args[0] === 'run-requested' || args[0] === 'restore-run' ? 2 : 1;
  if (args.length !== expected || !ACTIONS.has(args[0])) {
    throw new Refusal('invalid_request', `usage: ilex-backup ${[...ACTIONS].join('|')}`);
  }
  return { action: args[0], instance: args[1] ?? null };
}

export async function main(): Promise<number> {
  process.umask(0o077);
  const { action, instance } = checkStartup();
  const config = loadConfig();
  const paths = pathsFor(config);
  const input = readInput(MAX_INPUT_BYTES, 'invalid_request');

  // A stop (the unit stopped, a timeout): finish the current step's cleanup — a stopped app is
  // always started again — then end.
  process.on('SIGTERM', stopRunning);
  process.on('SIGINT', stopRunning);

  switch (action) {
    case 'configure':
      await configure(config, paths, input);
      emit('@@phase done');
      return 0;
    case 'init':
      await init(config, paths, input);
      return 0;
    case 'start':
      await startRun(config, paths, input);
      emit(`@@result ${JSON.stringify({ started: true })}`);
      return 0;
    case 'run-requested': {
      // Started by ilex-backup-now@<instance>.service (or, in development, by `start`).
      requireNoInput(input);
      const request = parseInstance(instance!);
      return run(config, paths, 'manual', request.runId, request.itemId);
    }
    case 'run-scheduled':
      requireNoInput(input);
      return run(config, paths, 'scheduled', randomUUID(), null);
    case 'check-scheduled':
      requireNoInput(input);
      return check(config, paths);
    case 'restore-start':
      await restoreStart(config, paths, input);
      emit(`@@result ${JSON.stringify({ started: true })}`);
      return 0;
    case 'restore-run':
      // Started by ilex-restore@<id>.service (or, in development, by `restore-start`).
      requireNoInput(input);
      return restoreRun(config, paths, instance!);
    case 'discard':
      await discard(config, paths, input);
      return 0;
    case 'forget':
      await forget(config, paths, input);
      return 0;
    case 'passphrase':
      requireNoInput(input);
      passphrase(paths);
      return 0;
  }
  throw new Refusal('invalid_request', 'unknown action');
}

/** Called by the entry (ilex-backup.mts) once it checked these modules. */
export function start(): void {
  finish(main, () => stopping);
}
