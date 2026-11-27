// backup/recover-borg.mts — runs as root.
//
// Borg with the passphrase the person typed, and the newest backup of Ilexarium on a disk.

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { prepareState, writeAtomic } from './files.mts';
import type { Config, Paths, Ran } from './model.mts';
import { ARCHIVE_PATTERN } from './plan.mts';
import { borgEnv, borgFailed, borgFailure, failedLine, runProgram } from './programs.mts';
import { archiveFolders } from './restore.mts';
import { Refusal } from '../lib/output.mts';

export const archiveTime = (name: string) => `${name.slice(-19)}.000Z`;

/**
 * Runs `fn` with the typed passphrase in a root-only file of its own, for Borg's
 * BORG_PASSCOMMAND (never in arguments or the environment); removed whatever happens.
 */
export async function withPassphrase<T>(
  config: Config,
  paths: Paths,
  passphrase: string,
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  prepareState(config, paths);
  const dir = join(paths.state, 'recover');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `passphrase.${process.pid}`);
  writeAtomic(file, `${passphrase}\n`, 0o400);
  try {
    // The disk may be mounted somewhere else than when Borg last saw it here: its id is checked.
    return await fn({
      ...borgEnv(config, { ...paths, passphrase: file }),
      BORG_RELOCATED_REPO_ACCESS_IS_OK: 'yes',
    });
  } finally {
    rmSync(file, { force: true });
  }
}

export const borgWith = (
  config: Config,
  env: Record<string, string>,
  command: string,
  args: string[],
  options: { cwd?: string; capture?: boolean } = {},
): Promise<Ran> =>
  runProgram(config.backup.borgBin, [command, '--log-json', ...args], { env, ...options });

/** The backups of Ilexarium itself (their comment lists its database dump), oldest first. */
export async function platformArchives(
  config: Config,
  paths: Paths,
  env: Record<string, string>,
  repository: string,
): Promise<{ name: string; time: string }[]> {
  const listed = await borgWith(
    config,
    env,
    'list',
    ['--json', '--format', '{comment}', repository],
    {
      capture: true,
    },
  );
  if (borgFailed(listed))
    throw new Refusal(borgFailure(listed), failedLine('borg list', listed), 5);
  let archives: { name?: unknown; comment?: unknown }[];
  try {
    archives = (JSON.parse(listed.stdout) as { archives?: typeof archives }).archives ?? [];
  } catch {
    throw new Refusal('borg_failed', 'borg list gave no JSON', 5);
  }
  const dump = join(paths.state, 'platform');
  const found = archives
    .filter(
      (a): a is { name: string; comment?: unknown } =>
        typeof a.name === 'string' &&
        ARCHIVE_PATTERN.test(a.name) &&
        (archiveFolders(JSON.stringify({ archives: [a] })) ?? []).includes(dump),
    )
    .map((a) => ({ name: a.name, time: archiveTime(a.name) }))
    .sort((a, b) => a.time.localeCompare(b.time));
  if (found.length === 0) {
    throw new Refusal('archive_not_found', 'no backup of Ilexarium on this disk', 5);
  }
  return found;
}
