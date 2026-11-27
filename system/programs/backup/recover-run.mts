// backup/recover-run.mts — runs as root.
//
// The recovery itself: everything checked first (the backup, its version, its plan, this
// repository's id), then the app stopped, the database restored, the files written, the app
// started again. No copy of what's replaced is kept: the backup stays the way back, and a
// recovery that fails midway is run again.

import { chownSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isObject } from './config.mts';
import { onCalendar } from './configure.mts';
import { repositoryId } from './destination.mts';
import { prepareState, writeAtomic } from './files.mts';
import type { Config, Paths, Plan } from './model.mts';
import { checkPlan } from './plan.mts';
import { borgFailed, borgFailure, failedLine, home, runProgram, takeLock } from './programs.mts';
import { accountsOf } from './recover-accounts.mts';
import { archiveTime, borgWith, newestPlatformArchive, withPassphrase } from './recover-borg.mts';
import { migrate, moveDestination, restoreDatabase } from './recover-database.mts';
import type {
  FromBackup,
  RecoveredAccount,
  RecoverRequest,
  RecoveryRecord,
} from './recover-model.mts';
import { Refusal, emit, oneLine } from '../lib/output.mts';
import { SAFE_PATH } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

/** Root mode: the app's hold (as updates use it) and the installed version. */
export const ROOT_RECOVER = { hold: '/run/ilex/updating', version: '/etc/ilex/version' };

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

const holdFile = (config: Config) =>
  isRoot ? ROOT_RECOVER.hold : join(config.backup.dev!.dir, 'updating');

const installedVersionFile = (config: Config) =>
  isRoot ? ROOT_RECOVER.version : config.backup.dev?.installedVersion;

/** The result, for the app and `ilex-recover`: written at every end. */
export function writeRecord(
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
  const file = join(paths.state, 'recovery.json');
  writeAtomic(file, `${JSON.stringify(entry, null, 2)}\n`, 0o640, config.backup.appGid);
  return entry;
}

export async function recoverPlatform(
  config: Config,
  paths: Paths,
  request: RecoverRequest,
): Promise<number> {
  const startedAt = new Date().toISOString();
  const phase = (name: string) => emit(`@@phase ${name}`);
  const staging = join(paths.state, 'recover', request.recoveryId);
  let release: (() => void) | null = null;
  let held = false;
  try {
    release = await takeLock(paths, false);
    prepareState(config, paths);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    return await withPassphrase(config, paths, request.passphrase, async (env) => {
      phase('checking');
      const newest = await newestPlatformArchive(config, paths, env, request.repository);
      if (newest.name !== request.archive) {
        throw new Refusal(
          'archive_not_found',
          'not the newest backup of Ilexarium on this disk',
          5,
        );
      }
      phase('extracting');
      const fromBackup = await extractBackup(config, paths, env, request, staging);

      phase('stopping');
      // Set first: a stop that fails still leaves the hold file, which only startApp removes.
      held = true;
      await holdApp(config);

      phase('restoring');
      await restoreDatabase(config, fromBackup.dump);
      if (fromBackup.moved) await moveDestination(config, fromBackup.plan.destination);
      await migrate(config, staging);
      writeFiles(config, paths, request, fromBackup);

      phase('accounts');
      const accounts = await accountsOf(config, env, request.repository, fromBackup.plan);
      const done = writeRecord(config, paths, request, startedAt, 'succeeded', null, accounts);

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
    // Stopped already: the database may be half restored — this machine's files are untouched.
    const message = held ? `${refusal.message}; run the recovery again` : refusal.message;
    try {
      writeRecord(config, paths, request, startedAt, 'failed', refusal.code, null);
    } catch {
      // The refusal below is still reported.
    }
    if (held) await startApp(config);
    throw new Refusal(refusal.code, oneLine(message), refusal.exitCode);
  } finally {
    // Only a run that holds the lock owns the staging folder (another may be using its own).
    if (release) {
      rmSync(staging, { recursive: true, force: true });
      release();
    }
  }
}

/** The backup's files into the root-only staging folder, then each checked. */
async function extractBackup(
  config: Config,
  paths: Paths,
  env: Record<string, string>,
  request: RecoverRequest,
  staging: string,
): Promise<FromBackup> {
  const dump = join(paths.state, 'platform', `${config.backup.platform.database}.dump`);
  const wanted = [dump, ...config.backup.platform.files].map((file) => file.slice(1));
  const extracted = join(staging, 'archive');
  mkdirSync(extracted, { mode: 0o700 });
  const extract = await borgWith(
    config,
    env,
    'extract',
    ['--numeric-ids', `${request.repository}::${request.archive}`, ...wanted],
    { cwd: extracted },
  );
  if (borgFailed(extract)) {
    throw new Refusal(borgFailure(extract), failedLine('borg extract', extract), 5);
  }
  return readBackup(
    config,
    paths,
    (file) => join(extracted, file.slice(1)),
    dump,
    request.repository,
  );
}

/**
 * What the backup holds, checked before anything here changes: its dump, its version (never a
 * newer Ilexarium's), its plan (moved to where the disk is now), its repository record for this
 * very repository (Borg's id), the key.
 */
function readBackup(
  config: Config,
  paths: Paths,
  staged: (file: string) => string,
  dump: string,
  repository: string,
): FromBackup {
  const plainFile = (file: string) => lstatSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
  const missing = (what: string) =>
    new Refusal('archive_not_found', `the backup holds no ${what}`, 5);
  const platformFile = (name: string) =>
    config.backup.platform.files.find((file) => basename(file) === name);
  if (!plainFile(staged(dump)) || lstatSync(staged(dump)).size === 0)
    throw missing('database dump');

  const versionFile = platformFile('version');
  const version =
    versionFile && plainFile(staged(versionFile)) ? readFileSync(staged(versionFile), 'utf8') : '';
  checkVersion(version.trim(), installedVersionFile(config));

  const json = (file: string): unknown => {
    if (!plainFile(file)) throw missing(basename(file));
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Refusal('archive_not_found', `${basename(file)} in the backup is damaged`, 5);
    }
  };
  const repoId = repositoryId(repository)!;
  const records = (json(staged(paths.repository)) as { repositories?: unknown }).repositories;
  if (!Array.isArray(records) || !records.some((r) => isObject(r) && r['id'] === repoId)) {
    throw new Refusal('repository_mismatch', 'the backup was made into another repository', 5);
  }
  const stored = json(staged(paths.plan));
  if (!isObject(stored)) throw new Refusal('archive_not_found', 'the backup’s plan is damaged', 5);
  const destination = dirname(repository);
  let plan: Plan;
  try {
    plan = checkPlan({ ...stored, destination }, config, paths);
  } catch (error) {
    const why = error instanceof Refusal ? error.message : String(error);
    throw new Refusal('invalid_plan', `the backup’s plan: ${why}`, 5);
  }
  const keyFile = platformFile('master.key');
  if (keyFile && !plainFile(staged(keyFile))) throw missing('key');
  return {
    dump: staged(dump),
    plan,
    repository: { path: repository, id: repoId },
    key: keyFile ? readFileSync(staged(keyFile)) : null,
    moved: stored['destination'] !== destination,
  };
}

/**
 * A newer Ilexarium's backup is refused, before anything changes: its database has migrations
 * this release doesn't know. A backup without a version file was made before Ilexarium kept one: older.
 */
export function checkVersion(backup: string, installedFile: string | undefined): void {
  const installed = installedFile ? readFileSync(installedFile, 'utf8').trim() : '';
  const [b, i] = [VERSION.exec(backup), VERSION.exec(installed)];
  if (!b || !i) return;
  for (let part = 1; part <= 3; part++) {
    const diff = Number(b[part]) - Number(i[part]);
    if (diff < 0) return;
    if (diff > 0) {
      throw new Refusal(
        'backup_newer',
        `the backup is from a newer Ilexarium (${backup}): update Ilexarium first`,
        5,
      );
    }
  }
}

/** The key (the app's), the plan, the repository record, the schedule, the passphrase. */
function writeFiles(
  config: Config,
  paths: Paths,
  request: RecoverRequest,
  fromBackup: FromBackup,
): void {
  writeAtomic(paths.plan, `${JSON.stringify(fromBackup.plan, null, 2)}\n`, 0o600);
  writeAtomic(
    paths.repository,
    `${JSON.stringify({ repositories: [fromBackup.repository] }, null, 2)}\n`,
    0o600,
  );
  writeAtomic(
    paths.timerDropIn,
    `# Written by ilex-backup recover.\n[Timer]\nOnCalendar=\nOnCalendar=${onCalendar(fromBackup.plan.schedule)}\n`,
    0o644,
  );
  writeAtomic(paths.passphrase, `${request.passphrase}\n`, 0o400);
  const keyFile = config.backup.platform.files.find((file) => basename(file) === 'master.key');
  if (keyFile && fromBackup.key) {
    writeAtomic(keyFile, fromBackup.key.toString('utf8'), 0o400);
    const { appUid, appGid } = config.backup;
    if (isRoot && appUid !== undefined && appGid !== undefined) chownSync(keyFile, appUid, appGid);
  }
}

const systemctl = (config: Config, args: string[]) =>
  runProgram(config.backup.systemctlBin!, args, { env: { PATH: SAFE_PATH, HOME: home(config) } });

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
