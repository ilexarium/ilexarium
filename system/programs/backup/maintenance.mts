// backup/maintenance.mts — runs as root.
//
// `forget`, `list` and `passphrase`.

import { existsSync, readFileSync } from 'node:fs';
import { openRepository } from './destination.mts';
import { prepareState } from './files.mts';
import { parseInput } from './input.mts';
import type { Config, Paths } from './model.mts';
import { ARCHIVE_PATTERN, UUID, loadPlan } from './plan.mts';
import { borg, borgFailed, borgFailure, failedLine, takeLock } from './programs.mts';
import { Refusal, emit } from '../lib/output.mts';
import { assertRootOwned } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export async function forget(config: Config, paths: Paths, input: string): Promise<void> {
  const { itemId } = parseInput(input, ['itemId']);
  if (typeof itemId !== 'string' || !UUID.test(itemId))
    throw new Refusal('invalid_request', 'itemId');
  const plan = loadPlan(config, paths);
  const item = plan.items.find((i) => i.id === itemId);
  // Only archives of an item no longer backed up (removed first, then confirmed).
  if (item && (!item.removed || item.kind === 'platform')) {
    throw new Refusal('invalid_request', 'the item is still backed up');
  }
  const release = await takeLock(paths, false);
  try {
    prepareState(config, paths);
    const repo = openRepository(config, paths, plan);
    emit('@@phase removing');
    const deleted = await borg(config, paths, 'delete', [
      '--glob-archives',
      `${itemId}-*`,
      repo.path,
    ]);
    if (borgFailed(deleted)) {
      throw new Refusal(borgFailure(deleted), failedLine('borg delete', deleted), 5);
    }
    const compact = await borg(config, paths, 'compact', [repo.path]);
    if (borgFailed(compact)) emit(`@@info ${failedLine('borg compact', compact)}`);
    emit('@@phase done');
  } finally {
    release();
  }
}

/**
 * Each plan item's archives as the repository has them now — for the Restore dialog: the app's
 * own list is from the last run it saw (a restored database is a run behind).
 */
export async function list(config: Config, paths: Paths): Promise<void> {
  const plan = loadPlan(config, paths);
  const release = await takeLock(paths, false);
  try {
    prepareState(config, paths);
    const repo = openRepository(config, paths, plan);
    const listed = await borg(config, paths, 'list', ['--json', repo.path], { capture: true });
    if (borgFailed(listed))
      throw new Refusal(borgFailure(listed), failedLine('borg list', listed), 5);
    let names: string[];
    try {
      const archives =
        (JSON.parse(listed.stdout) as { archives?: { name?: unknown }[] }).archives ?? [];
      names = archives.map((a) => String(a.name)).filter((name) => ARCHIVE_PATTERN.test(name));
    } catch {
      throw new Refusal('borg_failed', 'borg list gave no JSON', 5);
    }
    const archives: Record<string, string[]> = {};
    for (const item of plan.items) {
      archives[item.id] = names.filter((name) => name.startsWith(`${item.id}-`));
    }
    emit(`@@result ${JSON.stringify({ archives })}`);
  } finally {
    release();
  }
}

export function passphrase(paths: Paths): void {
  if (!existsSync(paths.passphrase)) throw new Refusal('passphrase_invalid', 'no passphrase', 6);
  if (isRoot) assertRootOwned(paths.passphrase);
  const value = readFileSync(paths.passphrase, 'utf8').trim();
  emit(`@@result ${JSON.stringify({ passphrase: value })}`);
}
