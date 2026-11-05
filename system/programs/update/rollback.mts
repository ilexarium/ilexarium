// The way back when an update doesn't come up: the installed version the installer kept in
// previous/ goes back in place — its folders, its units and settings, the database as it was
// before migrating — and is started again.

import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Progress } from './install.mts';
import { answersAs } from './install.mts';
import type { JobFile } from './job.mts';
import type { Paths, Programs } from './model.mts';
import { runProgram } from './programs.mts';
import { emit } from '../lib/output.mts';

const TREES = ['app', 'libexec', 'catalog', 'platform'];
const POSTGRES = 'laris-postgres-1';
const INSTALL_BACKUPS = '/var/lib/laris/install-backups';
const DUMP_NAME = /^laris-\d+\.\d+\.\d+-\d{8}-\d{6}\.dump$/;
const READY_TIMEOUT_MS = 90_000;
const START_TIMEOUT_MS = 90_000;
const unitName = /^laris[\w@.-]*\.(service|timer)$/;

export type RollbackResult = 'nothing_changed' | 'rolled_back' | 'rollback_failed';

export async function rollBack(
  paths: Paths,
  programs: Programs,
  job: JobFile,
  progress: Progress,
  from: string,
  sshUnit: string,
): Promise<RollbackResult> {
  const say = (line: string) => {
    job.event({ type: 'line', text: line });
    emit(`> ${line}`);
  };
  const run = (file: string, args: string[], stdinFile?: string, input?: string) =>
    runProgram(file, args, { stdinFile, input, onLine: say });

  // Nothing kept means nothing changed yet: the app (maybe never stopped) runs again.
  if (!progress.phases.has('saved')) {
    await run(programs.systemctl, ['start', 'laris.service']);
    return 'nothing_changed';
  }
  job.event({ type: 'phase', phase: 'rollback' });
  emit('@@phase rollback');
  const previous = join(paths.opt, 'previous');
  const kept = existsSync(join(previous, 'VERSION'))
    ? readFileSync(join(previous, 'VERSION'), 'utf8').trim()
    : '';
  if (kept !== from) {
    say(`The kept version is ${kept || 'unfinished'}, not ${from}: nothing put back`);
    return 'rollback_failed';
  }

  let ok = true;
  await run(programs.systemctl, ['stop', 'laris.service']);

  for (const tree of TREES) {
    const source = join(previous, tree);
    if (!existsSync(source)) continue;
    const target = join(paths.opt, tree);
    rmSync(`${target}.rollback`, { recursive: true, force: true });
    if ((await run(programs.cp, ['-a', source, `${target}.rollback`])) !== 0) {
      say(`${tree}: could not be copied back`);
      ok = false;
      continue;
    }
    rmSync(`${target}.failed`, { recursive: true, force: true });
    if (existsSync(target)) renameSync(target, `${target}.failed`);
    renameSync(`${target}.rollback`, target);
    rmSync(`${target}.failed`, { recursive: true, force: true });
  }

  // Units and settings the new version added go; the kept ones go back with their owners and modes.
  const keptFiles = join(previous, 'files');
  const keptUnits = join(keptFiles, paths.units.slice(paths.host.length));
  for (const name of readdirSync(paths.units).filter((n) => unitName.test(n))) {
    if (!existsSync(join(keptUnits, name))) rmSync(join(paths.units, name), { force: true });
  }
  for (const name of ['release.env', 'release.pub']) {
    if (!existsSync(join(keptFiles, paths.etc.slice(paths.host.length), name))) {
      rmSync(join(paths.etc, name), { force: true });
    }
  }
  if ((await run(programs.cp, ['-a', `${keptFiles}/.`, `${paths.host}/`])) !== 0) {
    say('The kept settings could not be put back');
    ok = false;
  }

  await run(programs.systemctl, ['daemon-reload']);
  await run(programs.tmpfiles, ['--create', '/etc/tmpfiles.d/laris.conf']);
  if ((await run(programs.systemctl, ['restart', 'laris-platform.service'])) !== 0) {
    say('The platform’s containers did not start');
    ok = false;
  }

  const dump = progress.dump && checkedDump(paths, progress.dump);
  if (progress.dump && !dump) {
    say(`Not a dump of the installer’s: ${progress.dump}`);
    ok = false;
  }
  if (dump && !(await restoreDatabase(programs, dump, run))) {
    say(`The database could not be put back; its dump: ${dump}`);
    ok = false;
  }

  await run(programs.systemctl, ['reload-or-restart', sshUnit]);
  await run(programs.systemctl, ['start', 'laris.service']);
  if (!(await answersAs(paths.healthUrl, from, START_TIMEOUT_MS))) {
    say(`${from} did not answer after it was put back`);
    ok = false;
  }
  return ok ? 'rolled_back' : 'rollback_failed';
}

/** Only a dump the installer made: in its folder (as it names it), by its name. */
function checkedDump(paths: Paths, dump: string): string | null {
  if (dirname(dump) !== INSTALL_BACKUPS || !DUMP_NAME.test(basename(dump))) return null;
  const file = join(paths.installBackups, basename(dump));
  try {
    const stat = lstatSync(file);
    return stat.isFile() && stat.size > 0 ? file : null;
  } catch {
    return null;
  }
}

type Run = (file: string, args: string[], stdinFile?: string, input?: string) => Promise<number>;

// Into an empty schema: pg_restore --clean drops only what the dump holds, and the new
// migrations' tables would stay — the next try of the same update would then fail to migrate.
async function restoreDatabase(programs: Programs, dump: string, run: Run): Promise<boolean> {
  const end = Date.now() + READY_TIMEOUT_MS;
  while (
    (await run(programs.docker, [
      'exec',
      POSTGRES,
      'pg_isready',
      '-q',
      '-U',
      'laris_owner',
      '-d',
      'laris',
    ])) !== 0
  ) {
    if (Date.now() > end) return false;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const psql = [
    'exec',
    '-i',
    POSTGRES,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
    '-X',
    '-U',
    'laris_owner',
    '-d',
    'laris',
  ];
  if (
    (await run(
      programs.docker,
      psql,
      undefined,
      'DROP SCHEMA public CASCADE;\nCREATE SCHEMA public;\n',
    )) !== 0
  ) {
    return false;
  }
  const restore = [
    'exec',
    '-i',
    POSTGRES,
    'pg_restore',
    '--exit-on-error',
    '-U',
    'laris_owner',
    '-d',
    'laris',
  ];
  return (await run(programs.docker, restore, dump)) === 0;
}
