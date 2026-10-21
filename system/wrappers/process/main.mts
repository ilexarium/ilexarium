// process/main.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The action, and the startup checks.

import { loadConfig } from './config.mts';
import { sendSignal } from './signal.mts';
import { emit, finish, Refusal } from '../lib/output.mts';
import { readInput } from '../lib/startup.mts';

export const ACTIONS = new Set(['signal']);

const MAX_INPUT_BYTES = 1024;

export function checkStartup(): string {
  if (process.env['NODE_OPTIONS'] !== undefined || process.execArgv.length > 0) {
    throw new Refusal('invalid_request', 'Node was started with options', 6);
  }
  const args = process.argv.slice(2);
  if (args.length !== 1 || !ACTIONS.has(args[0])) {
    throw new Refusal('invalid_request', `usage: laris-process ${[...ACTIONS].join('|')}`);
  }
  return args[0];
}

export async function main(): Promise<number> {
  process.umask(0o077);
  checkStartup();
  const config = loadConfig();
  const input = readInput(MAX_INPUT_BYTES, 'invalid_request');
  sendSignal(config, input);
  emit(`@@result ${JSON.stringify({ signalled: true })}`);
  return 0;
}

/** Called by the entry (laris-process.mts) once it checked these modules. */
export function start(): void {
  finish(main);
}
