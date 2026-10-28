// backup/maintenance.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// `forget` and `passphrase`.

import { existsSync, readFileSync } from 'node:fs';
import { openRepository } from './destination.mts';
import { prepareState } from './files.mts';
import { parseInput } from './input.mts';
import type { Config, Paths } from './model.mts';
import { UUID, loadPlan } from './plan.mts';
import { borg, borgFailure, takeLock } from './programs.mts';
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
    if (deleted.code >= 2) throw new Refusal(borgFailure(deleted.logs), 'borg delete failed', 5);
    const compact = await borg(config, paths, 'compact', [repo.path]);
    if (compact.code >= 2) emit('@@info borg compact failed');
    emit('@@phase done');
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
