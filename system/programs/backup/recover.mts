// backup/recover.mts — runs as root.
//
// Bringing Ilexarium back from the backup disk on a new (or reinstalled) machine: its database,
// the key that opens the secrets stored in it, the backup plan, its repository record and its
// schedule — from the newest backup of the platform item, the passphrase typed by the person.
// Never apps or folders: each is restored from the Backups page, as its owner's account.
//
//   recover-check   {"repository"?, "passphrase"?} → the repositories on mounted disks; with a
//                   repository and its passphrase, also its newest platform backups
//   recover         {"repository", "passphrase", "archive"} → the recovery itself (`ilex-recover`,
//                   run by root in a terminal)
//   recover-start   {"recoveryId", "repository", "passphrase", "archive"} → the app's: the request
//                   kept in a root-only file, run as ilex-recover@<id>.service (it stops the app)
//   recover-run <id>
//
// The passphrase only ever goes to a root-only file Borg reads (BORG_PASSCOMMAND), and to
// /etc/ilex/backup.passphrase once recovered: never in arguments, the environment or output.

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_MOUNTS, isObject } from './config.mts';
import { onCalendar } from './configure.mts';
import {
  REPOSITORY_FOLDER,
  checkDestination,
  destinationAllowed,
  mounts,
  repositoryId,
} from './destination.mts';
import { prepareState, writeAtomic } from './files.mts';
import { parseInput } from './input.mts';
import type { Config, Paths, Plan, Repository } from './model.mts';
import { askingAccount, outermost } from './places.mts';
import { ARCHIVE_PATTERN, UUID, checkPlan } from './plan.mts';
import {
  borgEnv,
  borgFailed,
  borgFailure,
  docker,
  failedLine,
  home,
  runProgram,
  sleep,
  takeLock,
} from './programs.mts';
import { archiveFolders } from './restore.mts';
import { startDetached, startUnit } from './start.mts';
import { readLines } from '../lib/lines.mts';
import { Refusal, emit, oneLine } from '../lib/output.mts';
import { SAFE_PATH, assertRootOwned, isPlainAbsolutePath } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const PASSPHRASE_MAX = 1024;

/** What a typed passphrase may not hold (it's one line). */
export const PASSPHRASE_FORBIDDEN = /[\x00-\x1f\x7f]/;

/** An account name the backups may list: a Linux one, offered in a `useradd` command. */
export const ACCOUNT_NAME_PATTERN = /^[a-z_][a-z0-9_.-]*\$?$/;
export const ACCOUNT_NAME_MAX = 32;

/** The newest platform backups `recover-check` answers with. */
export const ARCHIVES_SHOWN = 5;

/** Lines of `borg list` read for a folder's owner before giving up (its parents come first). */
export const OWNER_LINES_MAX = 64;

export const DATABASE_READY_MS = 90_000;

/** Root mode: the installed release and the platform's files the installer writes. */
export const ROOT_RECOVER = {
  hold: '/run/ilex/updating',
  appDir: '/opt/ilex/app',
  migrations: '/opt/ilex/app/apps/server/prisma/migrations',
  ownerPassword: '/etc/ilex/database-owner-password',
  node: '/usr/bin/node',
};

/** Development: this repository's migrations; the app's hold beside the dev files. */
const DEV_MIGRATIONS = fileURLToPath(
  new URL('../../../apps/server/prisma/migrations', import.meta.url),
);

const GRANTS = `REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE ilex TO ilex;
GRANT USAGE ON SCHEMA public TO ilex;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ilex;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ilex;
REVOKE ALL ON TABLE _prisma_migrations FROM ilex;
`;

const MIGRATIONS_QUERY =
  'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;\n';

interface RecoverRequest {
  recoveryId: string;
  repository: string;
  passphrase: string;
  archive: string;
  /** The uid whose sudo started it (`askingAccount`), never from the app. */
  askedBy: number;
}

export interface RecoveredAccount {
  uid: number;
  /** The account's name on the old machine, as Borg stored it. */
  name: string;
  /** The apps (by project) and folders whose files it owns. */
  items: string[];
}

/** What `recovery.json` holds: read by the app (its notice, its audit) and by `ilex-recover`. */
export interface RecoveryRecord {
  id: string;
  status: 'succeeded' | 'failed';
  errorCode: string | null;
  archive: string;
  archiveTime: string;
  repository: string;
  askedBy: number;
  startedAt: string;
  finishedAt: string;
  /** null: not checked (a failed recovery, or Borg couldn't list them). */
  accounts: RecoveredAccount[] | null;
}

const recoveryFile = (paths: Paths) => join(paths.state, 'recovery.json');

/** The result, for the app and `ilex-recover`: written at every end (best effort on a refusal). */
function writeRecord(
  config: Config,
  paths: Paths,
  request: Pick<RecoverRequest, 'recoveryId' | 'archive' | 'repository' | 'askedBy'>,
  startedAt: string,
  status: RecoveryRecord['status'],
  errorCode: string | null,
  accounts: RecoveredAccount[] | null,
): RecoveryRecord {
  const entry: RecoveryRecord = {
    id: request.recoveryId,
    status,
    errorCode,
    archive: request.archive,
    archiveTime: archiveTime(request.archive),
    repository: request.repository,
    askedBy: request.askedBy,
    startedAt,
    finishedAt: new Date().toISOString(),
    accounts,
  };
  prepareState(config, paths);
  writeAtomic(
    recoveryFile(paths),
    `${JSON.stringify(entry, null, 2)}\n`,
    0o640,
    config.backup.appGid,
  );
  return entry;
}
const requestFile = (paths: Paths, id: string) =>
  join(paths.state, 'recover-requests', `${id}.json`);
const archiveTime = (name: string) => `${name.slice(-19)}.000Z`;

function holdFile(config: Config): string {
  return isRoot ? ROOT_RECOVER.hold : join(config.backup.dev!.dir, 'updating');
}

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

/** The Borg repositories on the mounted disks that may hold backups: `<mount>/ilex-backups`. */
export function findRepositories(config: Config, paths: Paths): string[] {
  const found: string[] = [];
  for (const mountPoint of mounts(paths.mountInfo).keys()) {
    if (!destinationAllowed(config, paths, mountPoint) || SYSTEM_MOUNTS.includes(mountPoint)) {
      continue;
    }
    const path = join(mountPoint, REPOSITORY_FOLDER);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat?.isDirectory() && repositoryId(path)) found.push(path);
  }
  return found.sort();
}

/** A repository the person chose: one of those found, its disk safe to read from and write to. */
function checkRepository(config: Config, paths: Paths, value: unknown): string {
  if (typeof value !== 'string' || !isPlainAbsolutePath(value)) {
    throw new Refusal('invalid_request', 'repository', 2, 'repository');
  }
  if (!findRepositories(config, paths).includes(value)) {
    throw new Refusal('repository_mismatch', 'no backups there', 5);
  }
  checkDestination(config, paths, dirname(value));
  return value;
}

/**
 * Runs `fn` with the typed passphrase in a root-only file of its own, for Borg's
 * BORG_PASSCOMMAND; removed whatever happens.
 */
async function withPassphrase<T>(
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

const borgWith = (
  config: Config,
  env: Record<string, string>,
  command: string,
  args: string[],
  options: { cwd?: string; capture?: boolean } = {},
) => runProgram(config.backup.borgBin, [command, '--log-json', ...args], { env, ...options });

/** The platform's backups (those holding its database dump), newest first. */
async function platformArchives(
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
    { capture: true },
  );
  if (borgFailed(listed))
    throw new Refusal(borgFailure(listed), failedLine('borg list', listed), 5);
  const dump = join(paths.state, 'platform');
  let archives: { name?: unknown; comment?: unknown }[];
  try {
    archives = (JSON.parse(listed.stdout) as { archives?: typeof archives }).archives ?? [];
  } catch {
    throw new Refusal('borg_failed', 'borg list gave no JSON', 5);
  }
  return archives
    .filter(
      (a) =>
        typeof a.name === 'string' &&
        ARCHIVE_PATTERN.test(a.name) &&
        (archiveFolders(JSON.stringify({ archives: [a] })) ?? []).includes(dump),
    )
    .map((a) => ({ name: a.name as string, time: archiveTime(a.name as string) }))
    .sort((a, b) => b.time.localeCompare(a.time));
}

export async function recoverCheck(config: Config, paths: Paths, input: string): Promise<void> {
  const given = parseInput(input, [], ['repository', 'passphrase']);
  const repositories = findRepositories(config, paths);
  if (given['repository'] === undefined) {
    emit(`@@result ${JSON.stringify({ repositories })}`);
    return;
  }
  const repository = checkRepository(config, paths, given['repository']);
  const passphrase = checkPassphrase(given['passphrase']);
  const release = await takeLock(paths, false);
  try {
    const archives = await withPassphrase(config, paths, passphrase, (env) =>
      platformArchives(config, paths, env, repository),
    );
    if (archives.length === 0) {
      throw new Refusal('archive_not_found', 'no backup of Ilexarium on this disk', 5);
    }
    emit(
      `@@result ${JSON.stringify({ repositories, archives: archives.slice(0, ARCHIVES_SHOWN) })}`,
    );
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
    // Refused before it began (the disk unmounted since the check): the app waits for this file.
    const { archive, repository, askedBy } = given;
    if (typeof archive === 'string' && ARCHIVE_PATTERN.test(archive)) {
      const code = error instanceof Refusal ? error.code : 'internal';
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
          code,
          null,
        );
      } catch {
        // The refusal below is still reported.
      }
    }
    throw error;
  }
  return recoverPlatform(config, paths, request);
}

/** The files a recovery replaces, and how each is put back. */
interface Replaced {
  path: string;
  mode: number;
  owner: { uid: number; gid: number } | null;
}

function replacedFiles(config: Config, paths: Paths): Replaced[] {
  const { appUid, appGid } = config.backup;
  const key = config.backup.platform.files.find((file) => basename(file) === 'master.key');
  const list: Replaced[] = [
    { path: paths.passphrase, mode: 0o400, owner: null },
    { path: paths.plan, mode: 0o600, owner: null },
    { path: paths.repository, mode: 0o600, owner: null },
    { path: paths.timerDropIn, mode: 0o644, owner: null },
  ];
  if (key) {
    list.push({
      path: key,
      mode: 0o400,
      owner: appUid !== undefined && appGid !== undefined ? { uid: appUid, gid: appGid } : null,
    });
  }
  return list;
}

/** Writes a file root's way (or the key, the app's): whole, its owner and mode first. */
function putFile(file: Replaced, content: Buffer | string): void {
  writeAtomic(
    file.path,
    typeof content === 'string' ? content : content.toString('utf8'),
    file.mode,
  );
  if (isRoot && file.owner) chownSync(file.path, file.owner.uid, file.owner.gid);
}

async function recoverPlatform(
  config: Config,
  paths: Paths,
  request: RecoverRequest,
): Promise<number> {
  const startedAt = new Date().toISOString();
  const phase = (name: string) => emit(`@@phase ${name}`);
  const record = (
    status: RecoveryRecord['status'],
    errorCode: string | null,
    accounts: RecoveredAccount[] | null,
  ) => writeRecord(config, paths, request, startedAt, status, errorCode, accounts);
  const staging = join(paths.state, 'recover', request.recoveryId);
  let release: (() => void) | null = null;
  const replaced = replacedFiles(config, paths);
  let held = false;
  let saved = false;
  let changed = false;
  try {
    release = await takeLock(paths, false);
    prepareState(config, paths);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(join(staging, 'before'), { recursive: true, mode: 0o700 });
    const repoId = repositoryId(request.repository)!;
    return await withPassphrase(config, paths, request.passphrase, async (env) => {
      phase('checking');
      const archives = await platformArchives(config, paths, env, request.repository);
      if (!archives.some((a) => a.name === request.archive)) {
        throw new Refusal('archive_not_found', 'not a backup of Ilexarium on this disk', 5);
      }
      phase('extracting');
      const staged = (file: string) => join(staging, 'archive', file.slice(1));
      mkdirSync(join(staging, 'archive'), { recursive: true, mode: 0o700 });
      const dumpFile = join(paths.state, 'platform', `${config.backup.platform.database}.dump`);
      const wanted = [dumpFile, ...config.backup.platform.files].map((file) => file.slice(1));
      const extract = await borgWith(
        config,
        env,
        'extract',
        ['--numeric-ids', `${request.repository}::${request.archive}`, ...wanted],
        { cwd: join(staging, 'archive') },
      );
      if (borgFailed(extract)) {
        throw new Refusal(borgFailure(extract), failedLine('borg extract', extract), 5);
      }
      const fromBackup = readBackup(config, paths, staged, dumpFile, request.repository, repoId);

      phase('stopping');
      // Set first: a stop that fails still leaves the hold file, which only startApp removes.
      held = true;
      await holdApp(config);

      phase('saving');
      await saveCurrent(config, staging, replaced);
      saved = true;

      phase('restoring');
      changed = true;
      for (const file of replaced) {
        if (file.path === paths.passphrase) putFile(file, `${request.passphrase}\n`);
        else if (file.path === paths.plan)
          putFile(file, `${JSON.stringify(fromBackup.plan, null, 2)}\n`);
        else if (file.path === paths.repository) {
          putFile(file, `${JSON.stringify({ repositories: [fromBackup.repository] }, null, 2)}\n`);
        } else if (file.path === paths.timerDropIn) {
          putFile(
            file,
            `# Written by ilex-backup recover.\n[Timer]\nOnCalendar=\nOnCalendar=${onCalendar(fromBackup.plan.schedule)}\n`,
          );
        } else if (fromBackup.key !== null) putFile(file, fromBackup.key);
      }
      await restoreDatabase(config, staged(dumpFile));
      if (fromBackup.moved) await moveDestination(config, fromBackup.plan.destination);

      phase('migrating');
      await checkVersion(config, fromBackup.version);
      await migrate(config, staging);

      phase('accounts');
      const accounts = await accountsOf(config, env, request.repository, fromBackup.plan);
      const done = record('succeeded', null, accounts);

      phase('starting');
      await enableTimers(config);
      await startApp(config);
      held = false;
      phase('done');
      emit(`@@result ${JSON.stringify(done)}`);
      return 0;
    });
  } catch (error) {
    const refusal = error instanceof Refusal ? error : new Refusal('internal', String(error), 6);
    emit(`@@info ${oneLine(refusal.message)}`);
    if (changed && saved) {
      phase('rollback');
      await putBack(config, staging, replaced);
    }
    try {
      record('failed', refusal.code, null);
    } catch {
      // The result file is the app's to read; the way back above matters more.
    }
    if (held) await startApp(config);
    throw refusal;
  } finally {
    // Only a run that holds the lock owns the staging folder (another may be using its own).
    if (release) {
      rmSync(staging, { recursive: true, force: true });
      release();
    }
  }
}

interface FromBackup {
  plan: Plan;
  repository: Repository;
  key: Buffer | null;
  version: string | null;
  /** The disk is mounted somewhere else than when it was backed up. */
  moved: boolean;
}

/**
 * What the backup holds, checked before anything here changes: its dump, its plan (moved to where
 * the disk is now), its repository record for this very repository (Borg's id), the key.
 */
function readBackup(
  config: Config,
  paths: Paths,
  staged: (file: string) => string,
  dumpFile: string,
  repository: string,
  repoId: string,
): FromBackup {
  const plainFile = (file: string) => {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    return stat?.isFile() ? stat : null;
  };
  if (!plainFile(staged(dumpFile))?.size) {
    throw new Refusal('archive_not_found', 'the backup holds no database dump', 5);
  }
  const json = (file: string): unknown => {
    if (!plainFile(file))
      throw new Refusal('archive_not_found', `the backup holds no ${basename(file)}`, 5);
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Refusal('archive_not_found', `${basename(file)} in the backup is damaged`, 5);
    }
  };
  const stored = json(staged(paths.plan));
  const records = (json(staged(paths.repository)) as { repositories?: unknown }).repositories;
  const known = Array.isArray(records)
    ? records.some((r) => isObject(r) && r['id'] === repoId)
    : false;
  if (!known) {
    throw new Refusal('repository_mismatch', 'the backup was made into another repository', 5);
  }
  if (!isObject(stored)) throw new Refusal('archive_not_found', 'the backup’s plan is damaged', 5);
  const destination = dirname(repository);
  let plan: Plan;
  try {
    plan = checkPlan({ ...stored, destination }, config, paths);
  } catch (error) {
    const why = error instanceof Refusal ? error.message : String(error);
    throw new Refusal('invalid_plan', `the backup’s plan: ${why}`, 5);
  }
  const keyFile = config.backup.platform.files.find((file) => basename(file) === 'master.key');
  const key = keyFile && plainFile(staged(keyFile)) ? readFileSync(staged(keyFile)) : null;
  if (keyFile && !key) throw new Refusal('archive_not_found', 'the backup holds no key', 5);
  const versionFile = config.backup.platform.files.find((file) => basename(file) === 'version');
  const version =
    versionFile && plainFile(staged(versionFile))
      ? readFileSync(staged(versionFile), 'utf8').trim().slice(0, 40)
      : null;
  return {
    plan,
    repository: { path: repository, id: repoId },
    key,
    version: version && /^\d+\.\d+\.\d+$/.test(version) ? version : null,
    moved: stored['destination'] !== destination,
  };
}

const systemctl = (config: Config, args: string[]) =>
  runProgram(config.backup.systemctlBin!, args, {
    env: { PATH: SAFE_PATH, HOME: home(config) },
  });

/** A request while it's stopped waits instead of starting it half-way (as updates do). */
async function holdApp(config: Config): Promise<void> {
  writeAtomic(holdFile(config), '', 0o644);
  if (!config.backup.systemctlBin) return;
  const stopped = await systemctl(config, ['stop', 'ilex.service']);
  if (stopped.code !== 0) throw new Refusal('setup', 'the app could not be stopped', 6);
}

async function startApp(config: Config): Promise<void> {
  rmSync(holdFile(config), { force: true });
  if (!config.backup.systemctlBin) return;
  const started = await systemctl(config, ['start', 'ilex.service']);
  if (started.code !== 0) emit('@@info the app did not start (journalctl -u ilex)');
}

async function enableTimers(config: Config): Promise<void> {
  if (!config.backup.systemctlBin) return;
  for (const args of [
    ['daemon-reload'],
    ['enable', '--now', 'ilex-backup.timer', 'ilex-backup-check.timer'],
  ]) {
    const result = await systemctl(config, args);
    if (result.code !== 0) emit(`@@info systemctl ${args[0]} failed`);
  }
}

const psql = (config: Config, extra: string[] = []) => {
  const { container, database, user } = config.backup.platform;
  return [
    'exec',
    '-i',
    container,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
    '-X',
    `--username=${user}`,
    `--dbname=${database}`,
    ...extra,
  ];
};

async function databaseReady(config: Config): Promise<void> {
  const { container, database, user } = config.backup.platform;
  const end = Date.now() + (isRoot ? DATABASE_READY_MS : 2_000);
  while (
    (
      await docker(config, [
        'exec',
        container,
        'pg_isready',
        '-q',
        `--username=${user}`,
        `--dbname=${database}`,
      ])
    ).code !== 0
  ) {
    if (Date.now() > end) throw new Refusal('setup', 'the database does not answer', 6);
    await sleep(isRoot ? 2000 : 20);
  }
}

/** The database as it is now, sessions and all: the way back. */
async function saveCurrent(config: Config, staging: string, replaced: Replaced[]): Promise<void> {
  await databaseReady(config);
  const { container, database, user } = config.backup.platform;
  const fd = openSync(join(staging, 'before.dump'), 'w', 0o600);
  let dumped;
  try {
    dumped = await docker(
      config,
      [
        'exec',
        container,
        'pg_dump',
        `--username=${user}`,
        `--dbname=${database}`,
        '--format=custom',
      ],
      { stdoutFd: fd },
    );
  } finally {
    closeSync(fd);
  }
  if (dumped.code !== 0 || statSync(join(staging, 'before.dump')).size === 0) {
    throw new Refusal('dump_failed', 'the database here could not be saved first', 5);
  }
  replaced.forEach((file, index) => {
    if (existsSync(file.path)) copyFileSync(file.path, join(staging, 'before', String(index)));
  });
}

/** Into an emptied schema, as the owner: `--clean` would leave tables the dump doesn't hold. */
async function restoreDatabase(config: Config, dump: string): Promise<void> {
  await databaseReady(config);
  const emptied = await docker(config, psql(config), {
    input: 'DROP SCHEMA public CASCADE;\nCREATE SCHEMA public;\n',
  });
  if (emptied.code !== 0)
    throw new Refusal('restore_failed', 'the database could not be emptied', 5);
  const { container, database, user } = config.backup.platform;
  const fd = openSync(dump, 'r');
  try {
    const restored = await docker(
      config,
      [
        'exec',
        '-i',
        container,
        'pg_restore',
        '--exit-on-error',
        '--no-owner',
        `--username=${user}`,
        `--dbname=${database}`,
      ],
      { stdinFd: fd },
    );
    if (restored.code !== 0)
      throw new Refusal('restore_failed', 'the database could not be restored', 5);
  } finally {
    closeSync(fd);
  }
}

/** The app's plan follows the disk too (the database is the app's truth). */
async function moveDestination(config: Config, destination: string): Promise<void> {
  const moved = await docker(config, psql(config, ['-v', `destination=${destination}`]), {
    input: 'UPDATE "BackupPlan" SET destination = :\'destination\';\n',
  });
  if (moved.code !== 0)
    throw new Refusal('restore_failed', 'the plan could not follow the disk', 5);
}

/** A backup of a newer Ilexarium (a migration this release doesn't have) is refused. */
async function checkVersion(config: Config, version: string | null): Promise<void> {
  const folder = isRoot ? ROOT_RECOVER.migrations : DEV_MIGRATIONS;
  const installed = new Set(
    readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  const listed = await docker(config, psql(config, ['-t', '-A']), {
    input: MIGRATIONS_QUERY,
    capture: true,
  });
  if (listed.code !== 0)
    throw new Refusal('restore_failed', 'the restored database has no migrations', 5);
  const unknown = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name && !installed.has(name));
  if (unknown.length > 0) {
    throw new Refusal(
      'backup_newer',
      `the backup is from a newer Ilexarium${version ? ` (${version})` : ''}: update Ilexarium first`,
      5,
    );
  }
}

/**
 * This release's migrations (a backup of an older Ilexarium), as the database's owner, then the
 * app's role its rights again — as the installer does. Development: the developer migrates.
 */
async function migrate(config: Config, staging: string): Promise<void> {
  if (!isRoot) {
    emit('@@info development: migrations and grants are left to the developer');
    return;
  }
  assertRootOwned(ROOT_RECOVER.ownerPassword);
  const password = readFileSync(ROOT_RECOVER.ownerPassword, 'utf8').trim();
  if (!/^[0-9a-f]+$/.test(password))
    throw new Refusal('setup', 'the owner password is not the installer’s', 6);
  const migrated = await runProgram(
    ROOT_RECOVER.node,
    [join(ROOT_RECOVER.appDir, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: join(ROOT_RECOVER.appDir, 'apps/server'),
      env: {
        PATH: SAFE_PATH,
        HOME: staging,
        LANG: 'C.UTF-8',
        CHECKPOINT_DISABLE: '1',
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        DATABASE_URL: `postgresql://${config.backup.platform.user}:${password}@127.0.0.1:5432/${config.backup.platform.database}`,
      },
    },
  );
  if (migrated.code !== 0) throw new Refusal('restore_failed', 'the migrations failed', 5);
  const granted = await docker(config, psql(config), { input: GRANTS });
  if (granted.code !== 0)
    throw new Refusal('restore_failed', 'the app’s rights could not be set', 5);
}

/** After a failure: the files as they were, the database from its dump. */
async function putBack(config: Config, staging: string, replaced: Replaced[]): Promise<void> {
  replaced.forEach((file, index) => {
    const before = join(staging, 'before', String(index));
    try {
      if (existsSync(before)) putFile(file, readFileSync(before));
      else rmSync(file.path, { force: true });
    } catch {
      emit(`@@info ${file.path} could not be put back`);
    }
  });
  try {
    await restoreDatabase(config, join(staging, 'before.dump'));
  } catch {
    emit(`@@info the database could not be put back`);
  }
}

/**
 * Whose files each app and folder holds: the owner of its top folders in its newest backup — the
 * accounts this machine needs (restores keep owners by number). The first matching line of
 * `borg list` for each, never a full listing. Not fatal: null when Borg can't tell.
 */
async function accountsOf(
  config: Config,
  env: Record<string, string>,
  repository: string,
  plan: Plan,
): Promise<RecoveredAccount[] | null> {
  try {
    const listed = await borgWith(config, env, 'list', ['--json', repository], { capture: true });
    if (borgFailed(listed)) return null;
    const names = (
      (JSON.parse(listed.stdout) as { archives?: { name?: unknown }[] }).archives ?? []
    )
      .map((a) => String(a.name))
      .filter((name) => ARCHIVE_PATTERN.test(name));
    const byUid = new Map<number, RecoveredAccount>();
    for (const item of plan.items) {
      if (item.kind === 'platform' || item.removed) continue;
      const newest = names
        .filter((name) => name.startsWith(`${item.id}-`))
        .sort()
        .at(-1);
      if (!newest) continue;
      const info = await borgWith(config, env, 'info', ['--json', `${repository}::${newest}`], {
        capture: true,
      });
      const folders = info.code === 0 ? outermost(archiveFolders(info.stdout) ?? []) : [];
      const label = item.kind === 'app' ? item.project! : item.path!;
      for (const folder of folders) {
        const owner = await ownerOf(config, env, `${repository}::${newest}`, folder);
        if (!owner) continue;
        const account = byUid.get(owner.uid) ?? { uid: owner.uid, name: owner.name, items: [] };
        if (!account.items.includes(label)) account.items.push(label);
        byUid.set(owner.uid, account);
      }
    }
    return [...byUid.values()].sort((a, b) => a.uid - b.uid);
  } catch {
    return null;
  }
}

/** A folder's owner in an archive: the line of `borg list` for it, the listing stopped there. */
function ownerOf(
  config: Config,
  env: Record<string, string>,
  archive: string,
  folder: string,
): Promise<{ uid: number; name: string } | null> {
  const relative = folder.slice(1);
  return new Promise((resolve) => {
    const child = spawn(
      config.backup.borgBin,
      ['list', '--format', '{type} {uid} {user} {path}{NL}', archive, relative],
      { env, cwd: '/', stdio: ['ignore', 'pipe', 'ignore'], shell: false },
    );
    let found: { uid: number; name: string } | null = null;
    let lines = 0;
    readLines(
      child.stdout,
      64 * 1024,
      (line) => {
        if (found || ++lines > OWNER_LINES_MAX) {
          child.kill('SIGTERM');
          return;
        }
        const match = /^d (\d+) (\S*) (.*)$/.exec(line);
        if (match && match[3] === relative) {
          // A name that isn't a Linux one is left out: it would end up in a useradd command.
          const name =
            match[2].length <= ACCOUNT_NAME_MAX && ACCOUNT_NAME_PATTERN.test(match[2])
              ? match[2]
              : '';
          found = { uid: Number(match[1]), name };
          child.kill('SIGTERM');
        }
      },
      () => undefined,
    );
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(found));
  });
}
