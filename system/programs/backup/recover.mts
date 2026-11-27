// backup/recover.mts — runs as root.
//
// Bringing Ilexarium back from the backup disk on a new (or reinstalled) machine: its database,
// the key that opens the secrets stored in it, the backup plan, its repository record and its
// schedule — from the newest backup of the platform item, with the passphrase the person typed.
// Never apps or folders: each is restored from the Backups page, as its owner's account.
//
//   recover-check   {"repository", "passphrase"} → the backups of Ilexarium there, oldest first
//   recover         {"repository", "passphrase", "archive"} → the recovery (`ilex-recover`, run
//                   by root in a terminal)
//   recover-start   {"recoveryId", "repository", "passphrase", "archive"} → the app's: the request
//                   kept in a root-only file, run as ilex-recover@<id>.service (it stops the app)
//   recover-run <id>
//
// The steps: recover-run.mts. The passphrase only ever goes to root-only files (Borg's
// BORG_PASSCOMMAND, then /etc/ilex/backup.passphrase): never arguments, the environment or output.

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { REPOSITORY_FOLDER, checkDestination, repositoryId } from './destination.mts';
import { prepareState, writeAtomic } from './files.mts';
import { parseInput } from './input.mts';
import type { Config, Paths } from './model.mts';
import { askingAccount } from './places.mts';
import { ARCHIVE_PATTERN, UUID } from './plan.mts';
import { takeLock } from './programs.mts';
import { platformArchives, withPassphrase } from './recover-borg.mts';
import type { RecoverRequest } from './recover-model.mts';
import { recoverPlatform, writeRecord } from './recover-run.mts';
import { startDetached, startUnit } from './start.mts';
import { Refusal, emit } from '../lib/output.mts';
import { isPlainAbsolutePath } from '../lib/paths.mts';

export const PASSPHRASE_MAX = 1024;

/** What a typed passphrase may not hold (it's one line). */
export const PASSPHRASE_FORBIDDEN = /[\x00-\x1f\x7f]/;

const requestFile = (paths: Paths, id: string) =>
  join(paths.state, 'recover-requests', `${id}.json`);

function checkPassphrase(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > PASSPHRASE_MAX ||
    PASSPHRASE_FORBIDDEN.test(value)
  ) {
    throw new Refusal('invalid_request', 'passphrase', 2, 'passphrase');
  }
  return value.trim();
}

/**
 * The repository the person chose: `<disk>/ilex-backups` on a disk that may hold backups (the
 * same checks as setting up on it), a folder with a Borg repository's id.
 */
function checkRepository(config: Config, paths: Paths, value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isPlainAbsolutePath(value) ||
    basename(value) !== REPOSITORY_FOLDER
  ) {
    throw new Refusal('invalid_request', 'repository', 2, 'repository');
  }
  checkDestination(config, paths, dirname(value));
  const stat = lstatSync(value, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || !repositoryId(value)) {
    throw new Refusal('repository_mismatch', 'no backups there', 5);
  }
  return value;
}

export async function recoverCheck(config: Config, paths: Paths, input: string): Promise<void> {
  const given = parseInput(input, ['repository', 'passphrase']);
  const repository = checkRepository(config, paths, given['repository']);
  const passphrase = checkPassphrase(given['passphrase']);
  const release = await takeLock(paths, false);
  try {
    const archives = await withPassphrase(config, paths, passphrase, (env) =>
      platformArchives(config, paths, env, repository),
    );
    // Every one: the newest is offered, another can be chosen.
    emit(`@@result ${JSON.stringify({ archives })}`);
  } finally {
    release();
  }
}

function checkRequest(
  config: Config,
  paths: Paths,
  given: Record<string, unknown>,
  askedBy: unknown,
): RecoverRequest {
  const { recoveryId, archive } = given;
  if (typeof recoveryId !== 'string' || !UUID.test(recoveryId)) {
    throw new Refusal('invalid_request', 'recoveryId');
  }
  if (typeof askedBy !== 'number' || !Number.isInteger(askedBy) || askedBy < 0) {
    throw new Refusal('invalid_request', 'askedBy');
  }
  if (typeof archive !== 'string' || !ARCHIVE_PATTERN.test(archive)) {
    throw new Refusal('invalid_request', 'archive', 2, 'archive');
  }
  return {
    recoveryId,
    repository: checkRepository(config, paths, given['repository']),
    passphrase: checkPassphrase(given['passphrase']),
    archive,
    askedBy,
  };
}

/** `recover`: in the foreground (`ilex-recover`, root in a terminal). */
export async function recover(config: Config, paths: Paths, input: string): Promise<number> {
  const given = parseInput(input, ['repository', 'passphrase', 'archive']);
  const request = checkRequest(
    config,
    paths,
    { ...given, recoveryId: randomUUID() },
    askingAccount(config),
  );
  return recoverPlatform(config, paths, request);
}

/**
 * `recover-start` (the app, through the person's sudo): only while there's no backup plan here —
 * a machine set up already is recovered from a terminal. The request goes to a root-only file
 * (the passphrase with it, removed as the run starts), the run to its own unit: it stops the app.
 */
export async function recoverStart(config: Config, paths: Paths, input: string): Promise<void> {
  const given = parseInput(input, ['recoveryId', 'repository', 'passphrase', 'archive']);
  if (existsSync(paths.plan)) {
    throw new Refusal('already_configured', 'backups are set up here: use ilex-recover');
  }
  const request = checkRequest(config, paths, given, askingAccount(config));
  prepareState(config, paths);
  const file = requestFile(paths, request.recoveryId);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) throw new Refusal('busy', 'started already', 3);
  writeAtomic(file, `${JSON.stringify(request)}\n`, 0o600);
  if (await startUnit(config, `ilex-recover@${request.recoveryId}.service`)) return;
  startDetached(
    config,
    paths,
    ['recover-run', request.recoveryId],
    `recover-${request.recoveryId}.log`,
  );
}

/** `recover-run <id>` (ilex-recover@<id>.service). */
export async function recoverRun(config: Config, paths: Paths, id: string): Promise<number> {
  if (!UUID.test(id)) throw new Refusal('invalid_request', 'not a recovery id');
  const file = requestFile(paths, id);
  if (!existsSync(file)) throw new Refusal('not_found', 'no such recovery request');
  let given: Record<string, unknown>;
  try {
    given = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } finally {
    // The passphrase in it: gone before anything else happens.
    rmSync(file, { force: true });
  }
  let request: RecoverRequest;
  try {
    request = checkRequest(config, paths, given, given['askedBy']);
    if (request.recoveryId !== id) throw new Refusal('invalid_request', 'another recovery');
  } catch (error) {
    recordRefusal(config, paths, id, given, error);
    throw error;
  }
  return recoverPlatform(config, paths, request);
}

/** Refused before it began (the disk unmounted since the check): the app waits for this file. */
function recordRefusal(
  config: Config,
  paths: Paths,
  id: string,
  given: Record<string, unknown>,
  error: unknown,
): void {
  const { archive, repository, askedBy } = given;
  if (typeof archive !== 'string' || !ARCHIVE_PATTERN.test(archive)) return;
  const asked =
    typeof askedBy === 'number' && Number.isInteger(askedBy) && askedBy >= 0 ? askedBy : 0;
  try {
    writeRecord(
      config,
      paths,
      {
        recoveryId: id,
        archive,
        repository: typeof repository === 'string' ? repository : '',
        askedBy: asked,
      },
      new Date().toISOString(),
      'failed',
      error instanceof Refusal ? error.code : 'internal',
      null,
    );
  } catch {
    // The refusal is still reported.
  }
}
