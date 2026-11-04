// `start`: checks the request, writes it to a root-only file and has systemd start the update as
// its own unit, laris-update@<updateId>.service — it outlives the app and laris-root, which end
// when the installer stops the app. Returns at once; the app follows the job file.

import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { JobFile, prepareState } from './job.mts';
import type { Config, Paths, Programs } from './model.mts';
import { runProgram } from './programs.mts';
import { installedVersion, newer, readSource, VERSION } from './release.mts';
import { parseInput } from '../lib/input.mts';
import { lockHolder } from '../lib/lock.mts';
import { Refusal } from '../lib/output.mts';
import { SAFE_PATH } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const UPDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const requestFile = (paths: Paths, id: string) => join(paths.state, `${id}.request`);

export async function start(
  config: Config,
  paths: Paths,
  programs: Programs,
  input: string,
): Promise<{ from: string; to: string }> {
  const { updateId, version } = parseInput(input, ['updateId', 'version']);
  if (typeof updateId !== 'string' || !UPDATE_ID.test(updateId)) {
    throw new Refusal('invalid_request', 'updateId', 2, 'updateId');
  }
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Refusal('invalid_request', 'version', 2, 'version');
  }
  readSource(paths);
  const from = installedVersion(paths);
  if (!newer(version, from)) throw new Refusal('not_newer', `${from} is installed`);
  // A backup, restore or disk change holds the root programs' lock; the unit takes it for real.
  if (lockHolder(paths.lock).alive) throw new Refusal('busy', 'another operation runs', 3);
  prepareState(config, paths);
  if (readdirSync(paths.state).some((name) => name.endsWith('.request'))) {
    throw new Refusal('busy', 'an update is starting', 3);
  }
  if (existsSync(join(paths.state, `${updateId}.jsonl`))) {
    throw new Refusal('invalid_request', 'updateId used', 2, 'updateId');
  }

  writeFileSync(requestFile(paths, updateId), JSON.stringify({ version }), {
    mode: 0o600,
    flag: 'wx',
  });
  new JobFile(config, paths, updateId, true).event({ type: 'start', from, to: version });
  if (isRoot) {
    const code = await runProgram(programs.systemctl, [
      'start',
      '--no-block',
      `laris-update@${updateId}.service`,
    ]);
    if (code !== 0) throw new Refusal('setup', 'systemctl start failed', 6);
  } else {
    startDetached(paths, updateId);
  }
  return { from, to: version };
}

// Development (no systemd): the same run, detached — its own session, its output in a file.
function startDetached(paths: Paths, updateId: string): void {
  const entry = process.argv[1];
  const configFile = process.env['LARIS_WRAPPER_CONFIG'];
  if (!entry || !isAbsolute(entry) || !configFile)
    throw new Refusal('setup', 'cannot start the run', 6);
  const out = openSync(join(paths.state, `${updateId}.log`), 'w', 0o640);
  try {
    spawn(process.execPath, [entry, 'run', updateId], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { PATH: SAFE_PATH, LANG: 'C.UTF-8', LARIS_WRAPPER_CONFIG: configFile },
      cwd: '/',
      shell: false,
    }).unref();
  } finally {
    closeSync(out);
  }
}
