// compose/main.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The actions (`up`, `down`), and which one runs.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ID_PATTERN, loadEntry } from './catalog.mts';
import { compose, current, takeLock } from './compose.mts';
import { loadConfig } from './config.mts';
import { checkPolicy } from './policy.mts';
import { checkValues } from './values.mts';
import { ROOT_LOCK } from '../lib/lock.mts';
import { emit, finish, Refusal } from '../lib/output.mts';
import { isRoot, readInput } from '../lib/startup.mts';

export const MAX_INPUT_BYTES = 64 * 1024;

export const WAIT_TIMEOUT_SECONDS = 300;

export function checkStartup(): { action: 'up' | 'down'; id: string } {
  // A tripwire, not the lock: Node has already applied NODE_OPTIONS by now (see the header).
  if (process.env['NODE_OPTIONS'] !== undefined || process.execArgv.length > 0) {
    throw new Refusal('invalid_request', 'Node was started with options', 6);
  }
  const args = process.argv.slice(2);
  const [action, id] = args;
  if (args.length !== 2 || (action !== 'up' && action !== 'down')) {
    throw new Refusal('invalid_request', 'usage: homelab-compose up|down <catalog id>');
  }
  if (!ID_PATTERN.test(id)) throw new Refusal('invalid_request', 'not a catalog id');
  return { action, id };
}

/**
 * Root mode: the config, and every folder above it, must belong to root and be writable by no
 * one else — otherwise the app could have written it. Development mode (not root): the file
 * named by HOMELAB_WRAPPER_CONFIG, for tests and a machine without sudoers.
 */

export async function main(): Promise<number> {
  process.umask(0o077);
  const { action, id } = checkStartup();
  const config = loadConfig();
  const project = `hl-${id}`;
  const input = readInput(MAX_INPUT_BYTES, 'invalid_values');

  const release = takeLock(
    isRoot ? ROOT_LOCK : (config.lockFile ?? join(config.catalogDir, '.lock')),
  );
  const stop = () => {
    current?.kill('SIGTERM');
    release();
    process.exit(143);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    if (action === 'down') {
      if (input.length > 0) throw new Refusal('invalid_request', 'down takes no input');
      if (!existsSync(join(config.catalogDir, id)))
        throw new Refusal('unknown_entry', `no catalog entry ${id}`);
      emit('@@phase removing');
      // By project name only: removes its containers and network, never its volumes (no -v).
      const down = await compose(config, project, null, ['down', '--remove-orphans'], {});
      if (down.code !== 0) throw new Refusal('compose_failed', 'docker compose down failed', 5);
      emit('@@phase done');
      return 0;
    }

    const { meta, composeFile } = loadEntry(config, id);
    // Folders are created (if missing) with their final owner, so allow group/other reads again.
    process.umask(0o022);
    const values = checkValues(input, meta, config);
    process.umask(0o077);

    const rendered = await compose(
      config,
      project,
      composeFile,
      ['config', '--format', 'json'],
      values.env,
      true,
    );
    if (rendered.code !== 0) throw new Refusal('compose_failed', 'docker compose config failed', 5);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rendered.stdout);
    } catch {
      throw new Refusal('compose_failed', 'docker compose config printed no JSON', 5);
    }
    checkPolicy(parsed, project, values);

    emit('@@phase pulling');
    const pull = await compose(config, project, composeFile, ['pull'], values.env);
    if (pull.code !== 0) throw new Refusal('compose_failed', 'docker compose pull failed', 5);

    emit('@@phase starting');
    const up = await compose(
      config,
      project,
      composeFile,
      ['up', '-d', '--wait', '--wait-timeout', String(WAIT_TIMEOUT_SECONDS), '--remove-orphans'],
      values.env,
    );
    if (up.code !== 0) throw new Refusal('compose_failed', 'docker compose up failed', 5);
    emit('@@phase done');
    return 0;
  } finally {
    release();
  }
}

/** Called by the entry (homelab-compose.mts) once it checked these modules. */
export function start(): void {
  finish(main);
}
