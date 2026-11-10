// backup/start.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// `start` ("Back up now"): checks the request, then has systemd start the run as its own unit,
// ilex-backup-now@<runId>[_<itemId>].service, and returns at once. The run doesn't belong to
// the app: it goes on if the app stops, and is followed like a scheduled run (current.jsonl,
// runs.jsonl). The unit runs `ilex-backup run-requested <instance>`.

import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { prepareState } from './files.mts';
import { parseInput } from './input.mts';
import type { Config, Paths } from './model.mts';
import { UUID, loadPlan } from './plan.mts';
import { home, runProgram } from './programs.mts';
import { Refusal } from '../lib/output.mts';
import { SAFE_PATH } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A unit instance: the run's id, and the item's after `_` when it's one item. */
export const INSTANCE = new RegExp(`^(${UUID_TEXT})(?:_(${UUID_TEXT}))?$`);

export interface RunRequest {
  runId: string;
  itemId: string | null;
}

/** The instance `run-requested` was started with — from systemd, still checked. */
export function parseInstance(instance: string): RunRequest {
  const match = INSTANCE.exec(instance);
  if (!match) throw new Refusal('invalid_request', 'not a run instance');
  return { runId: match[1], itemId: match[2] ?? null };
}

export async function start(config: Config, paths: Paths, input: string): Promise<void> {
  const { runId, itemId } = parseInput(input, ['runId'], ['itemId']);
  if (typeof runId !== 'string' || !UUID.test(runId)) throw new Refusal('invalid_request', 'runId');
  if (itemId !== undefined && (typeof itemId !== 'string' || !UUID.test(itemId))) {
    throw new Refusal('invalid_request', 'itemId');
  }
  // What would refuse the run at once is refused here, while the app still waits for an answer.
  const plan = loadPlan(config, paths);
  if (itemId !== undefined && !plan.items.some((item) => item.id === itemId && !item.removed)) {
    throw new Refusal('item_not_found', 'no such item in the plan');
  }
  const instance = itemId === undefined ? runId : `${runId}_${itemId}`;
  parseInstance(instance);

  if (await startUnit(config, `ilex-backup-now@${instance}.service`)) return;
  startDetached(config, paths, ['run-requested', instance], 'requested-run.log');
}

/** Starts a unit of ours (`--no-block`: returns once systemd has it); false without systemd. */
export async function startUnit(config: Config, unit: string): Promise<boolean> {
  const systemctl = config.backup.systemctlBin;
  if (!systemctl) {
    if (isRoot) throw new Refusal('setup', 'no systemctl configured', 6);
    return false;
  }
  const result = await runProgram(systemctl, ['start', '--no-block', unit], {
    env: { PATH: SAFE_PATH, HOME: home(config) },
  });
  if (result.code !== 0) throw new Refusal('setup', 'systemctl start failed', 6);
  return true;
}

/**
 * Development (no systemd): the same action, detached from the app — its own session, its output
 * in <state>/<log>, never a pipe to the app.
 */
export function startDetached(config: Config, paths: Paths, args: string[], log: string): void {
  const entry = process.argv[1];
  const configFile = process.env['ILEX_WRAPPER_CONFIG'];
  if (!entry || !isAbsolute(entry) || !configFile) {
    throw new Refusal('setup', 'cannot start the run', 6);
  }
  prepareState(config, paths);
  const out = openSync(join(paths.state, log), 'w', 0o640);
  try {
    const child = spawn(process.execPath, [entry, ...args], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { PATH: SAFE_PATH, LANG: 'C.UTF-8', ILEX_WRAPPER_CONFIG: configFile },
      cwd: '/',
      shell: false,
    });
    child.unref();
  } finally {
    closeSync(out);
  }
}
