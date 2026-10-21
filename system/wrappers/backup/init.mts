// backup/init.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// `init`: the repository on a disk, and the passphrase.

import { randomInt } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPOSITORY_FOLDER,
  checkDestination,
  loadRepositories,
  repositoryId,
  saveRepository,
} from './destination.mts';
import { prepareState, writeAtomic } from './files.mts';
import { parseInput } from './input.mts';
import type { Config, Paths } from './model.mts';
import { borg, borgFailure, takeLock } from './programs.mts';
import { Refusal, emit } from '../lib/output.mts';
import { assertRootOwned } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

/** Beside the entry (laris-backup.mts), root-owned like it. */
export const WORDLIST = fileURLToPath(new URL('../eff_large_wordlist.txt', import.meta.url));

export const PASSPHRASE_WORDS = 6;

// init

/** Six words from the EFF large word list (7776 words: ~77 bits), chosen without bias. */
export function generatePassphrase(): string {
  if (isRoot) assertRootOwned(WORDLIST);
  const words = readFileSync(WORDLIST, 'utf8')
    .split('\n')
    .map((line) => line.split('\t')[1]?.trim())
    .filter((word): word is string => Boolean(word));
  if (words.length !== 7776 || new Set(words).size !== 7776) {
    throw new Refusal('setup', 'the word list is damaged', 6);
  }
  return Array.from({ length: PASSPHRASE_WORDS }, () => words[randomInt(words.length)]).join(' ');
}

export async function init(config: Config, paths: Paths, input: string): Promise<void> {
  const { destination } = parseInput(input, ['destination']);
  if (typeof destination !== 'string') throw new Refusal('invalid_request', 'destination');
  checkDestination(config, paths, destination);
  const path = join(destination, REPOSITORY_FOLDER);
  const release = await takeLock(paths, false);
  try {
    prepareState(config, paths);
    if (existsSync(path)) {
      // Ours already (setting up again on the same disk): nothing to do.
      const known = loadRepositories(paths).find((r) => r.path === path);
      const id = lstatSync(path).isSymbolicLink() ? null : repositoryId(path);
      if (known && id === known.id && existsSync(paths.passphrase)) {
        emit(`@@result ${JSON.stringify({ repositoryId: id, created: false })}`);
        return;
      }
      throw new Refusal('repository_exists', `${path} already exists`);
    }
    // The passphrase is kept across disks: one to write down.
    if (!existsSync(paths.passphrase)) {
      writeAtomic(paths.passphrase, `${generatePassphrase()}\n`, 0o400);
    }
    const result = await borg(config, paths, 'init', ['--encryption', 'repokey-blake2', path]);
    if (result.code !== 0) throw new Refusal(borgFailure(result.logs), 'borg init failed', 5);
    chmodSync(path, 0o700);
    const id = repositoryId(path);
    if (!id) throw new Refusal('borg_failed', 'the new repository has no id', 5);
    saveRepository(paths, { path, id });
    emit(`@@result ${JSON.stringify({ repositoryId: id, created: true })}`);
  } finally {
    release();
  }
}
