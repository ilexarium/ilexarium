// The actions, and which one runs.

import { loadConfig, pathsFor, programsFor } from './config.mts';
import { run } from './run.mts';
import { start } from './start.mts';
import { emit, finish, Refusal } from '../lib/output.mts';
import { readInput } from '../lib/startup.mts';

const MAX_INPUT_BYTES = 1024;

function checkStartup(): string[] {
  if (process.env['NODE_OPTIONS'] !== undefined || process.execArgv.length > 0) {
    throw new Refusal('invalid_request', 'Node was started with options', 6);
  }
  const args = process.argv.slice(2);
  const valid =
    (args.length === 1 && args[0] === 'start') || (args.length === 2 && args[0] === 'run');
  if (!valid) throw new Refusal('invalid_request', 'usage: laris-update start | run <updateId>');
  return args;
}

export async function main(): Promise<number> {
  process.umask(0o077);
  const [action, updateId] = checkStartup();
  const config = loadConfig();
  const paths = pathsFor(config);
  const programs = programsFor(config);
  if (action === 'start') {
    const result = await start(
      config,
      paths,
      programs,
      readInput(MAX_INPUT_BYTES, 'invalid_request'),
    );
    emit(`@@result ${JSON.stringify(result)}`);
    return 0;
  }
  // Stopping it halfway would leave a half-installed machine: it finishes, or goes back.
  process.on('SIGTERM', () => emit('@@info stopping is ignored until the update is done'));
  return run(config, paths, programs, updateId!);
}

export function startProgram(): void {
  finish(main);
}
