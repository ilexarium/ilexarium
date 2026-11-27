// Tests for bringing Ilexarium back from the backup disk (ilex-backup recover-check, recover,
// recover-start, recover-run) — in development mode, with the fake borg, docker and systemctl
// (testing/): the fake borg keeps the files it backs up (snapshot.txt) and writes them back.
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = fileURLToPath(new URL('./ilex-backup.mts', import.meta.url));
const FAKES = fileURLToPath(new URL('./testing/', import.meta.url));

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const APP = '22222222-2222-4222-8222-222222222222';
const FOLDER = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const RECOVERY = '66666666-6666-4666-8666-666666666666';

let dir: string;
let dev: string;
let storage: string;
let destination: string;

const repository = () => join(destination, 'ilex-backups');

function writeConfig() {
  writeFileSync(
    join(dir, 'wrappers.json'),
    JSON.stringify({
      protectedPaths: [],
      dockerBin: join(dir, 'docker'),
      lockFile: join(dir, 'run', 'compose.lock'),
      home: dir,
      backup: {
        borgBin: join(dir, 'borg'),
        systemctlBin: join(dir, 'systemctl'),
        platform: {
          container: 'ilex-postgres-1',
          database: 'ilex',
          user: 'ilex_owner',
          files: [
            join(dir, 'etc', 'master.key'),
            join(dev, 'backup.json'),
            join(dev, 'backup-repository.json'),
            join(dev, 'systemd', 'ilex-backup.timer.d', 'schedule.conf'),
            join(dir, 'etc', 'version'),
          ],
        },
        dev: {
          dir: dev,
          destinationRoots: [join(dir, 'mnt')],
          mountInfo: join(dir, 'mountinfo'),
          lockWaitMs: 300,
          retryDelayMs: 10,
        },
      },
    }),
  );
}

const mountLine = (point: string) => `100 30 8:17 / ${point} rw,relatime - ext4 /dev/sdb1 rw`;
const mountAt = (point: string) => writeFileSync(join(dir, 'mountinfo'), `${mountLine(point)}\n`);

interface Run {
  code: number | null;
  lines: string[];
  markers: string[];
  result: Record<string, any> | null;
}

function wrapper(action: string | string[], input: unknown = ''): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRAPPER, ...[action].flat()], {
      env: { ILEX_WRAPPER_CONFIG: join(dir, 'wrappers.json') },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    child.on('close', (code) => {
      const lines = out.split('\n').filter(Boolean);
      const resultLine = lines.findLast((l) => l.startsWith('@@result '));
      resolve({
        code,
        lines,
        markers: lines.filter((l) => l.startsWith('@@')),
        result: resultLine ? JSON.parse(resultLine.slice('@@result '.length)) : null,
      });
    });
  });
}

function expectRefused(result: Run, code: string, exitCode = 2) {
  expect(result.code, result.lines.join('\n')).toBe(exitCode);
  expect(result.markers.at(-1)).toMatch(new RegExp(`^@@error code=${code}( |$)`));
}

const jsonLines = (name: string): Record<string, any>[] =>
  existsSync(join(dir, name))
    ? readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const systemctlCalls = () => jsonLines('systemctl-calls.jsonl').map((c) => c.args.join(' '));
const psqlInputs = () => jsonLines('docker-stdin.jsonl').map((c) => c.stdin as string);
const recovery = () => JSON.parse(readFileSync(join(dev, 'state', 'recovery.json'), 'utf8'));
/** The passphrase `init` made on the old machine. */
let PASSPHRASE = '';

/** The old machine: set up, backed up once (the platform, an app, a folder). */
async function backedUp(): Promise<string> {
  const plan = {
    destination,
    schedule: { frequency: 'daily', time: '04:30' },
    retention: { daily: 7, weekly: 4, monthly: 6 },
    items: [
      { id: PLATFORM, kind: 'platform' },
      {
        id: APP,
        kind: 'app',
        project: 'navidrome',
        folders: [join(storage, 'anna', 'navidrome')],
        skip: [],
        mode: 'live',
      },
      { id: FOLDER, kind: 'folder', path: join(storage, 'bob', 'docs') },
    ],
  };
  expect((await wrapper('configure', plan)).code).toBe(0);
  expect((await wrapper('init', { destination })).code).toBe(0);
  PASSPHRASE = readFileSync(join(dev, 'backup.passphrase'), 'utf8').trim();
  writeFileSync(join(dir, 'passphrase.txt'), PASSPHRASE);
  const run = await wrapper(['run-requested', RUN]);
  expect(run.code, run.lines.join('\n')).toBe(0);
  const archives = Object.keys(JSON.parse(readFileSync(join(dir, 'archives.json'), 'utf8')));
  return archives.find((name) => name.startsWith(PLATFORM))!;
}

/** The new machine: Ilexarium installed again, no backup settings, a key of its own. */
function newMachine() {
  for (const file of ['backup.json', 'backup-repository.json', 'backup.passphrase']) {
    rmSync(join(dev, file), { force: true });
  }
  rmSync(join(dev, 'systemd'), { recursive: true, force: true });
  writeFileSync(join(dir, 'etc', 'master.key'), 'new machine key');
  rmSync(join(dir, 'systemctl-calls.jsonl'), { force: true });
  rmSync(join(dir, 'docker-stdin.jsonl'), { force: true });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-recover-'));
  chmodSync(dir, 0o755);
  dev = join(dir, 'dev');
  storage = join(dir, 'storage');
  destination = join(dir, 'mnt', 'usb');
  mkdirSync(join(storage, 'anna', 'navidrome'), { recursive: true });
  writeFileSync(join(storage, 'anna', 'navidrome', 'compose.yml'), 'services: {}');
  mkdirSync(join(storage, 'bob', 'docs'), { recursive: true });
  mkdirSync(destination, { recursive: true });
  mkdirSync(join(dir, 'etc'), { recursive: true });
  writeFileSync(join(dir, 'etc', 'master.key'), 'old machine key');
  writeFileSync(join(dir, 'etc', 'version'), '0.2.7\n');
  for (const fake of ['borg', 'docker', 'systemctl']) {
    const source = readFileSync(join(FAKES, `fake-${fake}.cjs`), 'utf8');
    writeFileSync(join(dir, fake), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  }
  writeFileSync(join(dir, 'snapshot.txt'), '');
  writeFileSync(join(dir, 'dump.txt'), 'PGDMP the old database\n');
  writeFileSync(
    join(dir, 'owners.json'),
    JSON.stringify({
      [join(storage, 'anna', 'navidrome')]: [1500, 'anna'],
      [join(storage, 'bob', 'docs')]: [1501, 'bob'],
    }),
  );
  mountAt(destination);
  writeConfig();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('recover-check', () => {
  it('finds the repositories on mounted disks, then the newest backups of Ilexarium', async () => {
    const archive = await backedUp();
    newMachine();
    const found = await wrapper('recover-check', {});
    expect(found.result).toEqual({ repositories: [repository()] });
    const checked = await wrapper('recover-check', {
      repository: repository(),
      passphrase: PASSPHRASE,
    });
    expect(checked.code, checked.lines.join('\n')).toBe(0);
    expect(checked.result!['archives']).toEqual([
      { name: archive, time: `${archive.slice(-19)}.000Z` },
    ]);
    // The typed passphrase went to a file of its own, gone again.
    expect(existsSync(join(dev, 'state', 'recover'))).toBe(true);
    expect(readFileSync(WRAPPER, 'utf8')).toContain('recover-check');
    expect(checked.lines.join('\n')).not.toContain(PASSPHRASE);
  });

  it('refuses a wrong passphrase, a repository not found, and bad input', async () => {
    await backedUp();
    newMachine();
    expectRefused(
      await wrapper('recover-check', { repository: repository(), passphrase: 'wrong words' }),
      'passphrase_invalid',
      5,
    );
    expectRefused(
      await wrapper('recover-check', {
        repository: join(dir, 'elsewhere'),
        passphrase: PASSPHRASE,
      }),
      'repository_mismatch',
      5,
    );
    expectRefused(
      await wrapper('recover-check', { repository: repository(), passphrase: 'two\nlines' }),
      'invalid_request',
    );
    expectRefused(await wrapper('recover-check', { repository: repository() }), 'invalid_request');
    expectRefused(await wrapper('recover-check', { other: 1 }), 'invalid_request');
  });
});

describe('recover', () => {
  it('brings Ilexarium back: the database, the key, the plan, the schedule, the passphrase', async () => {
    const archive = await backedUp();
    newMachine();
    const done = await wrapper('recover', {
      repository: repository(),
      passphrase: PASSPHRASE,
      archive,
    });
    expect(done.code, done.lines.join('\n')).toBe(0);
    expect(done.markers).toContain('@@phase done');
    expect(readFileSync(join(dir, 'etc', 'master.key'), 'utf8')).toBe('old machine key');
    expect(readFileSync(join(dev, 'backup.passphrase'), 'utf8')).toBe(`${PASSPHRASE}\n`);
    expect(statSync(join(dev, 'backup.passphrase')).mode & 0o777).toBe(0o400);
    expect(JSON.parse(readFileSync(join(dev, 'backup.json'), 'utf8')).destination).toBe(
      destination,
    );
    expect(
      readFileSync(join(dev, 'systemd', 'ilex-backup.timer.d', 'schedule.conf'), 'utf8'),
    ).toContain('OnCalendar=*-*-* 04:30:00');
    // The old database, into an emptied schema; the one here dumped first.
    const inputs = psqlInputs();
    expect(inputs).toContain('DROP SCHEMA public CASCADE;\nCREATE SCHEMA public;\n');
    expect(readFileSync(join(dir, 'restored-dumps.txt'), 'utf8')).toBe('PGDMP the old database\n');
    // The app held and stopped, the timers on, the app started again.
    expect(systemctlCalls()).toEqual([
      'stop ilex.service',
      'daemon-reload',
      'enable --now ilex-backup.timer ilex-backup-check.timer',
      'start ilex.service',
    ]);
    expect(existsSync(join(dev, 'updating'))).toBe(false);
    // Nothing left of the typed passphrase or the extracted files.
    expect(existsSync(join(dev, 'state', 'recover', RECOVERY))).toBe(false);
    expect(done.lines.join('\n')).not.toContain(PASSPHRASE);
    const record = recovery();
    expect(record).toMatchObject({ status: 'succeeded', errorCode: null, archive });
    expect(record.accounts).toEqual([
      { uid: 1500, name: 'anna', items: ['navidrome'] },
      { uid: 1501, name: 'bob', items: [join(storage, 'bob', 'docs')] },
    ]);
    expect(statSync(join(dev, 'state', 'recovery.json')).mode & 0o777).toBe(0o640);
  });

  it('moves the plan to where the disk is mounted now (the same repository)', async () => {
    const archive = await backedUp();
    newMachine();
    const moved = join(dir, 'mnt', 'other');
    renameSync(destination, moved);
    destination = moved;
    mountAt(moved);
    const done = await wrapper('recover', {
      repository: repository(),
      passphrase: PASSPHRASE,
      archive,
    });
    expect(done.code, done.lines.join('\n')).toBe(0);
    expect(JSON.parse(readFileSync(join(dev, 'backup.json'), 'utf8')).destination).toBe(moved);
    expect(JSON.parse(readFileSync(join(dev, 'backup-repository.json'), 'utf8'))).toEqual({
      repositories: [{ path: repository(), id: 'a'.repeat(64) }],
    });
    const update = jsonLines('docker-stdin.jsonl').find((c) => c.stdin.includes('UPDATE'));
    expect(update?.args).toContain(`destination=${moved}`);
  });

  it('refuses a backup made into another repository, before anything changes', async () => {
    const archive = await backedUp();
    newMachine();
    writeFileSync(join(repository(), 'config'), `[repository]\nid = ${'b'.repeat(64)}\n`);
    const refused = await wrapper('recover', {
      repository: repository(),
      passphrase: PASSPHRASE,
      archive,
    });
    expectRefused(refused, 'repository_mismatch', 5);
    expect(readFileSync(join(dir, 'etc', 'master.key'), 'utf8')).toBe('new machine key');
    expect(systemctlCalls()).toEqual([]);
    expect(recovery()).toMatchObject({ status: 'failed', errorCode: 'repository_mismatch' });
  });

  it('refuses a newer Ilexarium’s backup and puts everything back', async () => {
    const archive = await backedUp();
    newMachine();
    writeFileSync(join(dir, 'dump.txt'), 'PGDMP the new machine\n');
    writeFileSync(join(dir, 'migrations.txt'), '20991231000000_from_the_future\n');
    const refused = await wrapper('recover', {
      repository: repository(),
      passphrase: PASSPHRASE,
      archive,
    });
    expectRefused(refused, 'backup_newer', 5);
    expect(refused.lines.join('\n')).toContain('a newer Ilexarium (0.2.7)');
    expect(readFileSync(join(dir, 'restored-dumps.txt'), 'utf8')).toBe(
      'PGDMP the old database\nPGDMP the new machine\n',
    );
    expect(readFileSync(join(dir, 'etc', 'master.key'), 'utf8')).toBe('new machine key');
    expect(existsSync(join(dev, 'backup.json'))).toBe(false);
    expect(existsSync(join(dev, 'backup.passphrase'))).toBe(false);
    expect(systemctlCalls().at(-1)).toBe('start ilex.service');
    expect(existsSync(join(dev, 'updating'))).toBe(false);
  });

  it('puts everything back when the restore fails midway', async () => {
    const archive = await backedUp();
    newMachine();
    writeFileSync(join(dir, 'exit-pg_restore-once.txt'), '1');
    const refused = await wrapper('recover', {
      repository: repository(),
      passphrase: PASSPHRASE,
      archive,
    });
    expectRefused(refused, 'restore_failed', 5);
    expect(refused.markers).toContain('@@phase rollback');
    expect(readFileSync(join(dir, 'etc', 'master.key'), 'utf8')).toBe('new machine key');
    expect(existsSync(join(dev, 'backup.json'))).toBe(false);
    expect(systemctlCalls()).toEqual(['stop ilex.service', 'start ilex.service']);
    expect(recovery()).toMatchObject({
      status: 'failed',
      errorCode: 'restore_failed',
      accounts: null,
    });
  });

  it('refuses a wrong passphrase and an archive that isn’t Ilexarium’s, the app left running', async () => {
    const archive = await backedUp();
    newMachine();
    expectRefused(
      await wrapper('recover', { repository: repository(), passphrase: 'wrong', archive }),
      'passphrase_invalid',
      5,
    );
    const appArchive = archive.replace(PLATFORM, APP);
    expectRefused(
      await wrapper('recover', {
        repository: repository(),
        passphrase: PASSPHRASE,
        archive: appArchive,
      }),
      'archive_not_found',
      5,
    );
    expectRefused(
      await wrapper('recover', { repository: repository(), passphrase: PASSPHRASE, archive: 'x' }),
      'invalid_request',
    );
    expect(systemctlCalls()).toEqual([]);
  });
});

describe('recover-start and recover-run (the app’s way)', () => {
  it('keeps the request root-only, starts its unit; the run removes it first', async () => {
    const archive = await backedUp();
    newMachine();
    const started = await wrapper('recover-start', {
      recoveryId: RECOVERY,
      repository: repository(),
      passphrase: PASSPHRASE,
      archive,
    });
    expect(started.code, started.lines.join('\n')).toBe(0);
    expect(systemctlCalls()).toEqual([`start --no-block ilex-recover@${RECOVERY}.service`]);
    const request = join(dev, 'state', 'recover-requests', `${RECOVERY}.json`);
    expect(statSync(request).mode & 0o777).toBe(0o600);
    const run = await wrapper(['recover-run', RECOVERY]);
    expect(run.code, run.lines.join('\n')).toBe(0);
    expect(existsSync(request)).toBe(false);
    expect(recovery()).toMatchObject({ id: RECOVERY, status: 'succeeded' });
  });

  it('is refused once backups are set up here, and takes only its own keys', async () => {
    const archive = await backedUp();
    expectRefused(
      await wrapper('recover-start', {
        recoveryId: RECOVERY,
        repository: repository(),
        passphrase: PASSPHRASE,
        archive,
      }),
      'already_configured',
    );
    newMachine();
    expectRefused(
      await wrapper('recover-start', {
        recoveryId: 'x',
        repository: repository(),
        passphrase: PASSPHRASE,
        archive,
      }),
      'invalid_request',
    );
    expectRefused(await wrapper(['recover-run', 'not-an-id']), 'invalid_request');
    expectRefused(await wrapper(['recover-run', RECOVERY]), 'not_found');
    expectRefused(await wrapper('recover-run'), 'invalid_request');
  });
});
