// backup/recover-database.mts — runs as root.
//
// The platform's database during a recovery: emptied and restored from the backup's dump as its
// owner, the plan's disk where it is now, this release's migrations and the app's rights.

import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './model.mts';
import { docker, runProgram, sleep } from './programs.mts';
import { Refusal, emit } from '../lib/output.mts';
import { SAFE_PATH, assertRootOwned } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const DATABASE_READY_MS = 90_000;

/** Root mode: the installed release, and the owner's password the installer keeps. */
export const ROOT_DATABASE = {
  appDir: '/opt/ilex/app',
  ownerPassword: '/etc/ilex/database-owner-password',
  node: '/usr/bin/node',
};

/** The installer's grants (system/install/lib/platform.sh): the app's role reads and writes data. */
const GRANTS = `REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE ilex TO ilex;
GRANT USAGE ON SCHEMA public TO ilex;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ilex;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ilex;
REVOKE ALL ON TABLE _prisma_migrations FROM ilex;
`;

/** psql as the owner, inside the database's container; the SQL always on stdin. */
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
  const ready = () =>
    docker(config, [
      'exec',
      container,
      'pg_isready',
      '-q',
      `--username=${user}`,
      `--dbname=${database}`,
    ]);
  while ((await ready()).code !== 0) {
    if (Date.now() > end) throw new Refusal('setup', 'the database does not answer', 6);
    await sleep(isRoot ? 2000 : 20);
  }
}

/** Into an emptied schema, as the owner: `--clean` would leave tables the dump doesn't hold. */
export async function restoreDatabase(config: Config, dump: string): Promise<void> {
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

/** The app's plan follows the disk too (the database is the app's truth); psql quotes the value. */
export async function moveDestination(config: Config, destination: string): Promise<void> {
  const moved = await docker(config, psql(config, ['-v', `destination=${destination}`]), {
    input: 'UPDATE "BackupPlan" SET destination = :\'destination\';\n',
  });
  if (moved.code !== 0)
    throw new Refusal('restore_failed', 'the plan could not follow the disk', 5);
}

/**
 * This release's migrations (a backup of an older Ilexarium), as the database's owner, then the
 * app's role its rights again — as the installer does. Development: the developer migrates.
 */
export async function migrate(config: Config, home: string): Promise<void> {
  if (!isRoot) {
    emit('@@info development: migrations and grants are left to the developer');
    return;
  }
  assertRootOwned(ROOT_DATABASE.ownerPassword);
  const password = readFileSync(ROOT_DATABASE.ownerPassword, 'utf8').trim();
  if (!/^[0-9a-f]+$/.test(password)) {
    throw new Refusal('setup', 'the owner password is not the installer’s', 6);
  }
  const { user, database } = config.backup.platform;
  const migrated = await runProgram(
    ROOT_DATABASE.node,
    [join(ROOT_DATABASE.appDir, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: join(ROOT_DATABASE.appDir, 'apps/server'),
      env: {
        PATH: SAFE_PATH,
        HOME: home,
        LANG: 'C.UTF-8',
        CHECKPOINT_DISABLE: '1',
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        DATABASE_URL: `postgresql://${user}:${password}@127.0.0.1:5432/${database}`,
      },
    },
  );
  if (migrated.code !== 0) throw new Refusal('restore_failed', 'the migrations failed', 5);
  const granted = await docker(config, psql(config), { input: GRANTS });
  if (granted.code !== 0)
    throw new Refusal('restore_failed', 'the app’s rights could not be set', 5);
}
