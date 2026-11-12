// Tests for the backup wrapper (ilex-backup.mts) — run in development mode (not root), with a
// fake `borg` and a fake `docker` that record their calls (testing/). The same wrapper against
// the real Borg: ilex-backup.borg.spec.ts. Run by the server's unit tests.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTime } from './lib/lock.mts';

const WRAPPER = fileURLToPath(new URL('./ilex-backup.mts', import.meta.url));
const WORDLIST = fileURLToPath(new URL('./eff_large_wordlist.txt', import.meta.url));
const FAKES = fileURLToPath(new URL('./testing/', import.meta.url));

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const SERVICE = '22222222-2222-4222-8222-222222222222';
const LIVE = '33333333-3333-4333-8333-333333333333';
const FOLDER = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const RESTORE = '66666666-6666-4666-8666-666666666666';

let dir: string;
let storage: string;
let destination: string;
let dev: string;

function plan(change: Record<string, unknown> = {}): Record<string, any> {
  return {
    destination,
    schedule: { frequency: 'daily', time: '03:00' },
    retention: { daily: 7, weekly: 4, monthly: 6 },
    items: [
      { id: PLATFORM, kind: 'platform' },
      {
        id: SERVICE,
        kind: 'app',
        project: 'demo',
        folders: [join(storage, 'demo', 'data'), join(storage, 'demo', 'media')],
        skip: [join(storage, 'demo', 'data', 'cache')],
        mode: 'stop',
      },
      {
        id: LIVE,
        kind: 'app',
        project: 'live',
        folders: [join(storage, 'live')],
        skip: [join(storage, 'live', 'thumbs')],
        mode: 'live',
      },
      { id: FOLDER, kind: 'folder', path: join(storage, 'docs') },
    ],
    ...change,
  };
}

function writeConfig(change: Record<string, unknown> = {}) {
  const config = {
    protectedPaths: [join(storage, 'platform')],
    dockerBin: join(dir, 'docker'),
    lockFile: join(dir, 'run', 'compose.lock'),
    home: dir,
    backup: {
      borgBin: join(dir, 'borg'),
      platform: {
        container: 'ilex-postgres-1',
        database: 'ilex',
        user: 'ilex',
        files: [join(dir, 'etc', 'master.key'), join(dir, 'etc', 'missing.json')],
      },
      dev: {
        dir: dev,
        destinationRoots: [join(dir, 'mnt')],
        mountInfo: join(dir, 'mountinfo'),
        lockWaitMs: 300,
        retryDelayMs: 10,
      },
    },
    ...change,
  };
  writeFileSync(join(dir, 'wrappers.json'), JSON.stringify(config));
}

function writeMounts(lines: string[]) {
  writeFileSync(join(dir, 'mountinfo'), `${lines.join('\n')}\n`);
}
const mountLine = (point: string, type = 'ext4') =>
  `100 30 8:17 / ${point.replace(/ /g, '\\040')} rw,relatime shared:50 - ${type} /dev/sdb1 rw`;

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

/** "Back up now" as its unit runs it: `run-requested <runId>[_<itemId>]`, in the foreground. */
function runNow(request: { runId: string; itemId?: string }): Promise<Run> {
  const instance = request.itemId ? `${request.runId}_${request.itemId}` : request.runId;
  return wrapper(['run-requested', instance]);
}

/** The config with a (fake) systemctl, as in production. */
function useSystemctl() {
  const file = join(dir, 'wrappers.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.backup.systemctlBin = join(dir, 'systemctl');
  writeFileSync(file, JSON.stringify(config));
}

function calls(
  name: 'borg' | 'docker' | 'systemctl',
): { args: string[]; env: Record<string, string>; cwd: string }[] {
  const file = join(dir, `${name}-calls.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const borgCommands = () => calls('borg').map((c) => c.args[0]);
const resetCalls = () => {
  rmSync(join(dir, 'borg-calls.jsonl'), { force: true });
  rmSync(join(dir, 'docker-calls.jsonl'), { force: true });
};

function expectRefused(result: Run, code: string, exitCode = 2) {
  expect(result.code, result.lines.join('\n')).toBe(exitCode);
  expect(result.markers.at(-1)).toBe(`@@error code=${code}`);
}

function jsonLines(file: string): Record<string, any>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const jobFile = (id: string) => join(dev, 'state', 'jobs', `${id}.jsonl`);
const job = (id: string) => jsonLines(jobFile(id));
/** Every job file's events. */
function jobs(): Record<string, any>[][] {
  const folder = join(dev, 'state', 'jobs');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => jsonLines(join(folder, name)));
}
/** Each finished run's and check's result, oldest first (`type`: `run` or `check`). */
const results = (): Record<string, any>[] =>
  jobs()
    .map((events) => events.find((e) => e.type === 'runDone' || e.type === 'checkDone'))
    .filter((done) => done !== undefined)
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
    .map(({ type, ...result }) => ({ type: type.slice(0, -'Done'.length), ...result }));

async function setUp(change: Record<string, unknown> = {}) {
  const configured = await wrapper('configure', plan(change));
  expect(configured.code, configured.lines.join('\n')).toBe(0);
  const initialised = await wrapper('init', { destination });
  expect(initialised.code, initialised.lines.join('\n')).toBe(0);
  resetCalls();
}

const passphrase = () => readFileSync(join(dev, 'backup.passphrase'), 'utf8').trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-wrapper-'));
  chmodSync(dir, 0o755);
  storage = join(dir, 'storage');
  dev = join(dir, 'dev');
  destination = join(dir, 'mnt', 'usb');
  for (const folder of ['demo/data/cache', 'demo/media', 'live/thumbs', 'docs', 'platform']) {
    mkdirSync(join(storage, folder), { recursive: true });
  }
  writeFileSync(join(storage, 'demo', 'data', 'db.sqlite'), 'data');
  mkdirSync(destination, { recursive: true });
  mkdirSync(join(dir, 'etc'), { recursive: true });
  writeFileSync(join(dir, 'etc', 'master.key'), 'key');
  for (const fake of ['borg', 'docker', 'systemctl']) {
    const source = readFileSync(join(FAKES, `fake-${fake}.cjs`), 'utf8');
    writeFileSync(join(dir, fake), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  }
  writeFileSync(join(dir, 'running.txt'), 'demo\nlive');
  writeMounts([mountLine(destination)]);
  writeConfig();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ilex-backup starts safely', () => {
  it('starts through env -i, so the environment is emptied before Node starts', () => {
    expect(readFileSync(WRAPPER, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env -S -i /usr/bin/node');
  });

  it('takes exactly one known action (and run-requested its instance)', async () => {
    expectRefused(await wrapper('backup'), 'invalid_request');
    expectRefused(await wrapper('run'), 'invalid_request');
    expectRefused(await wrapper(['passphrase', 'x']), 'invalid_request');
    expectRefused(await wrapper('run-requested'), 'invalid_request');
    expectRefused(await wrapper(['run-requested', RUN, 'x']), 'invalid_request');
  });

  it('refuses input for actions that take none', async () => {
    expectRefused(await wrapper('passphrase', 'x'), 'invalid_request');
    expectRefused(await wrapper('run-scheduled', '{}'), 'invalid_request');
  });

  it('does nothing before a plan exists', async () => {
    expectRefused(await wrapper('run-scheduled'), 'not_configured', 6);
    expectRefused(await wrapper('check-scheduled'), 'not_configured', 6);
  });

  it('ships the unchanged EFF large word list', () => {
    const hash = createHash('sha256').update(readFileSync(WORDLIST)).digest('hex');
    expect(hash).toBe('addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e');
  });
});

describe('ilex-backup configure', () => {
  it('writes the plan (root-only) and the timer’s schedule', async () => {
    const result = await wrapper('configure', plan());
    expect(result.code, result.lines.join('\n')).toBe(0);
    expect(JSON.parse(readFileSync(join(dev, 'backup.json'), 'utf8'))).toEqual(plan());
    expect(statSync(join(dev, 'backup.json')).mode & 0o777).toBe(0o600);
    const timer = readFileSync(
      join(dev, 'systemd', 'ilex-backup.timer.d', 'schedule.conf'),
      'utf8',
    );
    expect(timer).toContain('OnCalendar=\nOnCalendar=*-*-* 03:00:00\n');
  });

  it.each([
    ['daily', '23:45', '*-*-* 23:45:00'],
    ['every12h', '15:30', '*-*-* 03,15:30:00'],
    ['every6h', '02:00', '*-*-* 02,08,14,20:00:00'],
    ['every6h', '23:10', '*-*-* 05,11,17,23:10:00'],
  ])('schedules %s from %s as %s', async (frequency, time, calendar) => {
    expect((await wrapper('configure', plan({ schedule: { frequency, time } }))).code).toBe(0);
    const timer = readFileSync(
      join(dev, 'systemd', 'ilex-backup.timer.d', 'schedule.conf'),
      'utf8',
    );
    expect(timer).toContain(`OnCalendar=${calendar}\n`);
  });

  it('accepts home folders (they are only read)', async () => {
    const items = [...plan().items, { id: RUN, kind: 'folder', path: '/home/alice/Documents' }];
    expect((await wrapper('configure', plan({ items }))).code).toBe(0);
  });

  const withItem = (item: Record<string, unknown>) => plan({ items: [plan().items[0], item] });
  it.each<[string, () => Record<string, any>]>([
    ['a destination outside /mnt and /media', () => plan({ destination: storage })],
    ['the destination root itself', () => plan({ destination: join(dir, 'mnt') })],
    ['a destination with ".."', () => plan({ destination: `${destination}/../x` })],
    ['an unknown frequency', () => plan({ schedule: { frequency: 'hourly', time: '03:00' } })],
    [
      'a calendar expression as time',
      () => plan({ schedule: { frequency: 'daily', time: '*-*-* 03:00' } }),
    ],
    ['no daily backups kept', () => plan({ retention: { daily: 0, weekly: 4, monthly: 6 } })],
    ['an unknown key', () => plan({ hooks: ['rm -rf /'] })],
    ['no platform item', () => plan({ items: plan().items.slice(1) })],
    ['two platform items', () => plan({ items: [...plan().items, { id: RUN, kind: 'platform' }] })],
    ['a folder in /etc', () => withItem({ id: RUN, kind: 'folder', path: '/etc' })],
    ['a folder in /root', () => withItem({ id: RUN, kind: 'folder', path: '/root/secrets' })],
    ['all of /', () => withItem({ id: RUN, kind: 'folder', path: '/' })],
    [
      'Docker’s own folder',
      () => withItem({ id: RUN, kind: 'folder', path: '/var/lib/docker/volumes' }),
    ],
    [
      'a platform folder',
      () => withItem({ id: RUN, kind: 'folder', path: join(storage, 'platform') }),
    ],
    ['a relative folder', () => withItem({ id: RUN, kind: 'folder', path: 'docs' })],
    ['a folder holding the disk', () => withItem({ id: RUN, kind: 'folder', path: dir })],
    ['a folder twice', () => plan({ items: [...plan().items, { ...plan().items[3], id: RUN }] })],
    ['a duplicate item id', () => plan({ items: [...plan().items, { ...plan().items[3] }] })],
    [
      'an item id that is not a uuid',
      () => withItem({ id: 'x', kind: 'folder', path: join(storage, 'docs') }),
    ],
    [
      'an app project that is not a Compose name',
      () => withItem({ ...plan().items[1], id: RUN, project: '../demo' }),
    ],
    [
      'an app folder in a system folder',
      () => withItem({ ...plan().items[1], id: RUN, folders: ['/etc/ssh'] }),
    ],
    [
      'an app skip outside its folders',
      () => withItem({ ...plan().items[1], id: RUN, skip: [join(storage, 'docs', 'x')] }),
    ],
    [
      'an app skip that could read as an option or more of a pattern',
      () => withItem({ ...plan().items[1], id: RUN, skip: [join(storage, 'demo', 'data', '-x')] }),
    ],
    [
      'an app skip with ..',
      () =>
        withItem({ ...plan().items[1], id: RUN, skip: [join(storage, 'demo', 'data', '..', 'x')] }),
    ],
    ['an app without a mode', () => withItem({ ...plan().items[1], id: RUN, mode: 'pause' })],
    [
      'a service item',
      () => withItem({ id: RUN, kind: 'service', catalogId: 'demo', folders: {} }),
    ],
    [
      'a skip list on a folder item',
      () => withItem({ id: RUN, kind: 'folder', path: join(storage, 'docs'), skip: ['x'] }),
    ],
  ])('refuses %s', async (_, value) => {
    expectRefused(await wrapper('configure', value()), 'invalid_plan');
    expect(existsSync(join(dev, 'backup.json'))).toBe(false);
  });
});

describe('ilex-backup init', () => {
  beforeEach(async () => {
    expect((await wrapper('configure', plan())).code).toBe(0);
  });

  it('creates the passphrase (six words, root-only) and the repository', async () => {
    const result = await wrapper('init', { destination });
    expect(result.code, result.lines.join('\n')).toBe(0);
    expect(result.result).toEqual({ repositoryId: 'a'.repeat(64), created: true });
    const words = passphrase().split(' ');
    const list = new Set(
      readFileSync(WORDLIST, 'utf8')
        .split('\n')
        .map((l) => l.split('\t')[1]),
    );
    expect(words).toHaveLength(6);
    expect(words.every((word) => list.has(word))).toBe(true);
    expect(statSync(join(dev, 'backup.passphrase')).mode & 0o777).toBe(0o400);
    const repo = join(destination, 'ilex-backups');
    expect(calls('borg').map((c) => c.args)).toEqual([
      ['init', '--log-json', '--encryption', 'repokey-blake2', repo],
    ]);
    expect(JSON.parse(readFileSync(join(dev, 'backup-repository.json'), 'utf8'))).toEqual({
      repositories: [{ path: repo, id: 'a'.repeat(64) }],
    });
  });

  it('keeps knowing the old disk when a new one is set up (a refused plan change strands nothing)', async () => {
    await wrapper('init', { destination });
    const other = join(dir, 'mnt', 'other');
    mkdirSync(other, { recursive: true });
    writeMounts([mountLine(destination), mountLine(other)]);
    writeFileSync(join(dir, 'repo-id.txt'), 'c'.repeat(64));
    expect((await wrapper('init', { destination: other })).code).toBe(0);
    const { repositories } = JSON.parse(readFileSync(join(dev, 'backup-repository.json'), 'utf8'));
    expect(repositories.map((r: { path: string }) => r.path)).toEqual([
      join(destination, 'ilex-backups'),
      join(other, 'ilex-backups'),
    ]);
    // The plan still names the first disk (its change never happened): runs still work there.
    expect((await runNow({ runId: RUN, itemId: FOLDER })).code).toBe(0);
  });

  it('never shows the passphrase: not in arguments, environment or output', async () => {
    const result = await wrapper('init', { destination });
    const secret = passphrase();
    expect(result.lines.join('\n')).not.toContain(secret);
    for (const call of calls('borg')) {
      expect(JSON.stringify(call)).not.toContain(secret);
      expect(call.env['BORG_PASSCOMMAND']).toBe(`/usr/bin/cat ${join(dev, 'backup.passphrase')}`);
      expect(call.env['BORG_PASSPHRASE']).toBeUndefined();
    }
  });

  it('is a no-op on the same disk again, and refuses a folder that is not ours', async () => {
    await wrapper('init', { destination });
    const again = await wrapper('init', { destination });
    expect(again.code).toBe(0);
    expect(again.result).toEqual({ repositoryId: 'a'.repeat(64), created: false });

    const other = join(dir, 'mnt', 'other');
    mkdirSync(join(other, 'ilex-backups'), { recursive: true });
    writeMounts([mountLine(destination), mountLine(other)]);
    expectRefused(await wrapper('init', { destination: other }), 'repository_exists');
  });

  it('refuses a folder that is not a mounted disk (it would fill the system disk)', async () => {
    writeMounts([mountLine(join(dir, 'mnt'))]);
    expectRefused(await wrapper('init', { destination }), 'destination_unavailable', 5);
    expect(calls('borg')).toEqual([]);
  });

  it('refuses unsupported disk formats', async () => {
    writeMounts([mountLine(destination, 'vfat')]);
    expectRefused(await wrapper('init', { destination }), 'destination_unavailable', 5);
  });

  it('refuses a destination reached through a symlink', async () => {
    const link = join(dir, 'mnt', 'link');
    symlinkSync(destination, link);
    writeMounts([mountLine(link)]);
    expectRefused(await wrapper('init', { destination: link }), 'destination_unavailable', 5);
  });

  it('refuses a disk everyone may write to (the repository could be swapped)', async () => {
    chmodSync(destination, 0o777);
    expectRefused(await wrapper('init', { destination }), 'destination_unavailable', 5);
  });

  it('refuses destinations outside /mnt and /media, and other input', async () => {
    expectRefused(await wrapper('init', { destination: storage }), 'destination_not_allowed');
    expectRefused(await wrapper('init', { destination, passphrase: 'x' }), 'invalid_request');
    expectRefused(await wrapper('init', 'nope'), 'invalid_request');
  });
});

describe('ilex-backup run', () => {
  beforeEach(() => setUp());

  it('backs up the platform, then services, then folders — one archive each', async () => {
    const result = await runNow({ runId: RUN });
    expect(result.code, result.lines.join('\n')).toBe(0);
    const creates = calls('borg').filter((c) => c.args[0] === 'create');
    const archive = (args: string[]) => args.find((a) => a.includes('::'))!.split('::')[1];
    expect(creates.map((c) => archive(c.args).slice(0, 36))).toEqual([
      PLATFORM,
      SERVICE,
      LIVE,
      FOLDER,
    ]);
    for (const create of creates) {
      expect(archive(create.args)).toMatch(/^[0-9a-f-]{36}-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    }
    expect(borgCommands().at(-1)).toBe('compact');
  });

  it('dumps the database inside its container, without sessions, and removes the dump afterwards', async () => {
    await runNow({ runId: RUN });
    expect(calls('docker')[0].args).toEqual([
      'exec',
      'ilex-postgres-1',
      'pg_dump',
      '--username=ilex',
      '--dbname=ilex',
      '--format=custom',
      '--exclude-table-data="Session"',
    ]);
    const create = calls('borg').find((c) => c.args[0] === 'create')!;
    const dumpDir = join(dev, 'state', 'platform');
    // The dump folder and the platform files that exist.
    expect(create.args.slice(-2)).toEqual([dumpDir, join(dir, 'etc', 'master.key')]);
    expect(existsSync(dumpDir)).toBe(false);
  });

  it('skips what the recipe says, by full path, never as a pattern', async () => {
    await runNow({ runId: RUN });
    const creates = calls('borg').filter((c) => c.args[0] === 'create');
    const demo = creates[1].args;
    expect(demo).toEqual([
      'create',
      '--log-json',
      '--json',
      '--compression',
      'zstd,3',
      '--comment',
      JSON.stringify([join(storage, 'demo', 'data'), join(storage, 'demo', 'media')]),
      '--exclude',
      `pp:${join(storage, 'demo', 'data')}/cache`,
      expect.stringMatching(new RegExp(`::${SERVICE}-`)),
      join(storage, 'demo', 'data'),
      join(storage, 'demo', 'media'),
    ]);
    expect(creates[2].args).toContain(`pp:${join(storage, 'live')}/thumbs`);
  });

  it('stops a `stop` service around its archive, and only that one', async () => {
    await runNow({ runId: RUN });
    const compose = calls('docker')
      .filter((c) => c.args[0] === 'compose')
      .map((c) => c.args.slice(2).join(' '));
    expect(compose).toEqual(['demo ps -q', 'demo stop', 'demo start']);
    expect(readFileSync(join(dir, 'running.txt'), 'utf8')).toContain('demo');
  });

  it('starts a stopped service again even when its archive fails', async () => {
    writeFileSync(join(dir, 'exit-create.txt'), '2');
    const result = await runNow({ runId: RUN });
    expect(result.code).toBe(5);
    const compose = calls('docker')
      .filter((c) => c.args[0] === 'compose')
      .map((c) => c.args[3]);
    expect(compose).toEqual(['ps', 'stop', 'start']);
    expect(readFileSync(join(dir, 'running.txt'), 'utf8')).toContain('demo');
  });

  it('retries starting a service, and reports one that did not start as the most serious failure', async () => {
    writeFileSync(join(dir, 'start-fails.txt'), '2');
    expect((await runNow({ runId: RUN })).code).toBe(0);
    rmSync(join(dir, 'archives.json'));

    writeFileSync(join(dir, 'running.txt'), 'demo');
    writeFileSync(join(dir, 'start-fails.txt'), '3');
    const result = await runNow({ runId: RUN });
    expect(result.code).toBe(5);
    const demo = results()
      .at(-1)!
      .items.find((i: any) => i.itemId === SERVICE);
    expect(demo).toMatchObject({ status: 'failed', errorCode: 'service_not_restarted' });
    // The archive itself was made.
    expect(demo.archive).toMatch(new RegExp(`^${SERVICE}-`));
  });

  it('leaves a stopped service alone (it was not running)', async () => {
    writeFileSync(join(dir, 'running.txt'), '');
    await runNow({ runId: RUN });
    const compose = calls('docker')
      .filter((c) => c.args[0] === 'compose')
      .map((c) => c.args[3]);
    expect(compose).toEqual(['ps']);
  });

  it('records results: per item, with sizes and the archives left after pruning', async () => {
    await runNow({ runId: RUN });
    const [run] = results();
    expect(run).toMatchObject({
      type: 'run',
      runId: RUN,
      trigger: 'manual',
      itemId: null,
      status: 'ok',
      errorCode: null,
    });
    expect(run.items).toHaveLength(4);
    expect(run.items[3]).toMatchObject({
      itemId: FOLDER,
      status: 'ok',
      originalBytes: 1000,
      addedBytes: 100,
      warnings: [],
      archives: [run.items[3].archive],
    });
    expect(statSync(jobFile(run.runId)).mode & 0o777).toBe(0o640);
  });

  it('prunes each item by its own archives, with the plan’s retention', async () => {
    await runNow({ runId: RUN, itemId: FOLDER });
    const prune = calls('borg').find((c) => c.args[0] === 'prune')!;
    expect(prune.args).toEqual([
      'prune',
      '--log-json',
      '--glob-archives',
      `${FOLDER}-*`,
      '--keep-daily',
      '7',
      '--keep-weekly',
      '4',
      '--keep-monthly',
      '6',
      join(destination, 'ilex-backups'),
    ]);
  });

  it('keeps the last four of the day when running every 6 hours', async () => {
    await wrapper('configure', plan({ schedule: { frequency: 'every6h', time: '03:00' } }));
    await runNow({ runId: RUN, itemId: FOLDER });
    expect(calls('borg').find((c) => c.args[0] === 'prune')!.args).toContain('--keep-hourly');
  });

  it('backs up one item when asked to', async () => {
    await runNow({ runId: RUN, itemId: FOLDER });
    expect(borgCommands()).toEqual(['create', 'prune', 'list', 'compact']);
    expect(results()[0]).toMatchObject({ itemId: FOLDER });
    expectRefused(await runNow({ runId: RUN, itemId: RESTORE }), 'item_not_found');
  });

  it('writes live progress: the run, each item’s phases and result, the end', async () => {
    await runNow({ runId: RUN, itemId: SERVICE });
    const events = job(RUN);
    expect(events[0]).toMatchObject({
      type: 'run',
      runId: RUN,
      trigger: 'manual',
      items: [SERVICE],
    });
    expect(typeof events[0].pid).toBe('number');
    const phases = events.filter((e) => e.type === 'item').map((e) => e.phase);
    expect(phases).toEqual(['stopping', 'archiving', 'starting', 'pruning']);
    expect(events.find((e) => e.type === 'itemDone')!.result).toMatchObject({
      itemId: SERVICE,
      status: 'ok',
    });
    expect(events.at(-1)).toMatchObject({ type: 'runDone', runId: RUN, status: 'ok' });
    expect(statSync(jobFile(RUN)).mode & 0o777).toBe(0o640);
    expect(statSync(join(dev, 'state', 'jobs')).mode & 0o777).toBe(0o750);
  });

  it('keeps the newest job files, so the folder never grows without end', async () => {
    const folder = join(dev, 'state', 'jobs');
    mkdirSync(folder, { recursive: true });
    for (let i = 0; i < 520; i++) {
      const old = join(folder, `old-${i}.jsonl`);
      writeFileSync(old, '');
      utimesSync(old, 1_000 + i, 1_000 + i);
    }
    await runNow({ runId: RUN, itemId: FOLDER });
    const names = readdirSync(folder);
    expect(names).toHaveLength(500);
    expect(names).toContain(`${RUN}.jsonl`);
    expect(names).not.toContain('old-0.jsonl');
    expect(names).toContain('old-519.jsonl');
  });

  it('keeps a long output line cut, as the app reads it (never losing the result)', async () => {
    const long = { type: 'log_message', levelname: 'INFO', message: 'x'.repeat(5000), msgid: '' };
    writeFileSync(join(dir, 'logs-create.jsonl'), JSON.stringify(long));
    await runNow({ runId: RUN, itemId: FOLDER });
    const done = job(RUN).find((e) => e.type === 'runDone')!;
    expect(Math.max(...done.output.map((line: string) => line.length))).toBeLessThanOrEqual(2000);
  });

  it('completes with warnings when Borg warns (files changed while read)', async () => {
    const warning = {
      type: 'log_message',
      levelname: 'WARNING',
      message: '/x: file changed while we backed it up',
      msgid: '',
    };
    writeFileSync(join(dir, 'logs-create.jsonl'), JSON.stringify(warning));
    writeFileSync(join(dir, 'exit-create.txt'), '1');
    const result = await runNow({ runId: RUN, itemId: FOLDER });
    expect(result.code).toBe(0);
    expect(results()[0]).toMatchObject({ status: 'warning' });
    expect(results()[0].items[0]).toMatchObject({
      status: 'warning',
      warnings: ['/x: file changed while we backed it up'],
    });
  });

  it('fails one item whose folder is missing, and goes on with the others', async () => {
    rmSync(join(storage, 'docs'), { recursive: true });
    const result = await runNow({ runId: RUN });
    expect(result.code).toBe(5);
    const run = results()[0];
    expect(run.status).toBe('failed');
    expect(run.items.map((i: any) => [i.itemId, i.status, i.errorCode])).toEqual([
      [PLATFORM, 'ok', null],
      [SERVICE, 'ok', null],
      [LIVE, 'ok', null],
      [FOLDER, 'failed', 'source_missing'],
    ]);
  });

  it('refuses a source swapped for a symlink', async () => {
    rmSync(join(storage, 'docs'), { recursive: true });
    symlinkSync('/etc', join(storage, 'docs'));
    await runNow({ runId: RUN, itemId: FOLDER });
    expect(results()[0].items[0]).toMatchObject({ status: 'failed', errorCode: 'source_missing' });
    expect(borgCommands()).not.toContain('create');
  });

  it('reports a full disk', async () => {
    const full = {
      type: 'log_message',
      levelname: 'ERROR',
      message: '[Errno 28] No space left on device',
      msgid: '',
    };
    writeFileSync(join(dir, 'logs-create.jsonl'), JSON.stringify(full));
    writeFileSync(join(dir, 'exit-create.txt'), '2');
    await runNow({ runId: RUN, itemId: FOLDER });
    expect(results()[0].items[0]).toMatchObject({ status: 'failed', errorCode: 'disk_full' });
  });

  it('writes nothing when the disk is not mounted', async () => {
    writeMounts([]);
    const result = await runNow({ runId: RUN });
    expect(result.code).toBe(5);
    expect(result.markers.at(-1)).toBe('@@error code=destination_unavailable');
    expect(calls('borg')).toEqual([]);
    expect(results()[0]).toMatchObject({
      status: 'failed',
      errorCode: 'destination_unavailable',
      items: [],
    });
    expect(job(RUN).at(-1)).toMatchObject({ type: 'runDone', status: 'failed' });
  });

  it('writes nothing to a repository that is not ours (and never creates one)', async () => {
    writeFileSync(
      join(destination, 'ilex-backups', 'config'),
      `[repository]\nid = ${'b'.repeat(64)}\n`,
    );
    expect((await runNow({ runId: RUN })).markers.at(-1)).toBe('@@error code=repository_mismatch');
    rmSync(join(destination, 'ilex-backups'), { recursive: true });
    expect((await runNow({ runId: RUN })).markers.at(-1)).toBe('@@error code=repository_mismatch');
    expect(calls('borg')).toEqual([]);
  });

  it('fails the run when the passphrase file is missing', async () => {
    rmSync(join(dev, 'backup.passphrase'), { force: true });
    const result = await runNow({ runId: RUN });
    expect(result.markers.at(-1)).toBe('@@error code=passphrase_invalid');
    expect(calls('borg')).toEqual([]);
  });

  it('never puts the passphrase in arguments, the environment, output or results', async () => {
    const result = await runNow({ runId: RUN });
    const secret = passphrase();
    expect(result.lines.join('\n')).not.toContain(secret);
    expect(JSON.stringify(calls('borg'))).not.toContain(secret);
    expect(JSON.stringify(calls('docker'))).not.toContain(secret);
    expect(readFileSync(jobFile(RUN), 'utf8')).not.toContain(secret);
  });

  it('gives Borg a clean environment', async () => {
    await runNow({ runId: RUN, itemId: FOLDER });
    expect(calls('borg')[0].env).toEqual({
      PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: dir,
      LANG: 'C.UTF-8',
      BORG_BASE_DIR: join(dev, 'state', 'borg'),
      BORG_PASSCOMMAND: `/usr/bin/cat ${join(dev, 'backup.passphrase')}`,
      BORG_DISPLAY_PASSPHRASE: 'no',
      BORG_FILES_CACHE_TTL: '100',
      BORG_RELOCATED_REPO_ACCESS_IS_OK: 'no',
      BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK: 'no',
      BORG_CHECK_I_KNOW_WHAT_I_AM_DOING: 'NO',
      BORG_DELETE_I_KNOW_WHAT_I_AM_DOING: 'NO',
    });
    expect(calls('borg')[0].cwd).toBe('/');
  });

  it('runs one operation at a time: a manual run is refused, a scheduled one waits, then gives up — recorded', async () => {
    mkdirSync(join(dir, 'run'), { recursive: true });
    writeFileSync(join(dir, 'run', 'compose.lock'), String(process.pid));
    expectRefused(await runNow({ runId: RUN }), 'busy', 3);
    // Nobody waits on a "Back up now" run's output: the refusal shows in the app through the file.
    expect(results()).toEqual([
      expect.objectContaining({
        runId: RUN,
        trigger: 'manual',
        status: 'failed',
        errorCode: 'busy',
      }),
    ]);
    const started = Date.now();
    expectRefused(await wrapper('run-scheduled'), 'busy', 3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(calls('borg')).toEqual([]);
    // The skipped scheduled run shows in the app at once.
    expect(results().slice(1)).toEqual([
      expect.objectContaining({
        type: 'run',
        trigger: 'scheduled',
        status: 'failed',
        errorCode: 'busy',
        items: [],
      }),
    ]);
  });

  it('reads the plan once the lock is its own (a change made while it waited counts)', async () => {
    mkdirSync(join(dir, 'run'), { recursive: true });
    writeFileSync(join(dir, 'run', 'compose.lock'), String(process.pid));
    const waiting = wrapper('run-scheduled');
    await new Promise((r) => setTimeout(r, 100));
    const items = plan().items.map((i: any) => (i.id === FOLDER ? { ...i, removed: true } : i));
    await wrapper('configure', plan({ items }));
    rmSync(join(dir, 'run', 'compose.lock'));
    expect((await waiting).code).toBe(0);
    expect(results()[0].items.map((i: any) => i.itemId)).toEqual([PLATFORM, SERVICE, LIVE]);
  });

  it('takes over a lock whose pid now belongs to another process (its start time differs)', async () => {
    mkdirSync(join(dir, 'run'), { recursive: true });
    const lock = join(dir, 'run', 'compose.lock');
    const start = startTime(process.pid);
    expect(start).toMatch(/^\d+$/);
    writeFileSync(lock, `${process.pid} ${start}`);
    expectRefused(await runNow({ runId: RUN }), 'busy', 3);
    writeFileSync(lock, `${process.pid} ${Number(start) + 1}`);
    expect((await runNow({ runId: RUN, itemId: FOLDER })).code).toBe(0);
  });

  it('never takes over a lock being written, only one long dead', async () => {
    mkdirSync(join(dir, 'run'), { recursive: true });
    const lock = join(dir, 'run', 'compose.lock');
    writeFileSync(lock, ''); // an older writer between creating and writing it
    expectRefused(await runNow({ runId: RUN }), 'busy', 3);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect((await runNow({ runId: RUN, itemId: FOLDER })).code).toBe(0);
  });

  it('leaves no partial database dump behind when the dump fails', async () => {
    writeFileSync(join(dir, 'exit-exec.txt'), '1');
    await runNow({ runId: RUN, itemId: PLATFORM });
    expect(results()[0].items[0]).toMatchObject({ status: 'failed', errorCode: 'dump_failed' });
    expect(existsSync(join(dev, 'state', 'platform'))).toBe(false);
  });

  it('a scheduled run is recorded as scheduled, with an id of its own', async () => {
    expect((await wrapper('run-scheduled')).code).toBe(0);
    expect(results()[0].trigger).toBe('scheduled');
    expect(results()[0].runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a bad instance (from systemd, still checked) and any input', async () => {
    for (const instance of [
      'x',
      `${RUN}_../x`,
      `${RUN}_`,
      `${RUN}_${FOLDER}_${FOLDER}`,
      `${RUN} `,
    ]) {
      expectRefused(await wrapper(['run-requested', instance]), 'invalid_request');
    }
    expectRefused(await wrapper(['run-requested', RUN], '{}'), 'invalid_request');
    expect(calls('borg')).toEqual([]);
  });

  it('skips removed items', async () => {
    const items = plan().items.map((i: any) => (i.id === FOLDER ? { ...i, removed: true } : i));
    await wrapper('configure', plan({ items }));
    await runNow({ runId: RUN });
    expect(results()[0].items.map((i: any) => i.itemId)).toEqual([PLATFORM, SERVICE, LIVE]);
  });
});

describe('ilex-backup restore', () => {
  let archive: string;
  let folderArchive: string;

  beforeEach(async () => {
    await setUp();
    expect((await runNow({ runId: RUN })).code).toBe(0);
    const items = results()[0].items;
    archive = items.find((i: any) => i.itemId === SERVICE).archive;
    folderArchive = items.find((i: any) => i.itemId === FOLDER).archive;
    resetCalls();
    useSystemctl();
  });

  const restoreInput = (change: Record<string, unknown> = {}) => ({
    restoreId: RESTORE,
    itemId: SERVICE,
    archive,
    target: null,
    ...change,
  });
  const events = () => job(RESTORE);
  const done = () => events().find((e) => e.type === 'restoreDone');
  /** As the person's sudo starts it, then as its unit runs it. */
  async function restore(input: Record<string, unknown>): Promise<Run> {
    const started = await wrapper('restore-start', input);
    expect(started.code, started.lines.join('\n')).toBe(0);
    return wrapper(['restore-run', RESTORE]);
  }

  it('restore-start keeps the request (root-only) and starts its unit, nothing more', async () => {
    const started = await wrapper('restore-start', restoreInput());
    expect(started.code, started.lines.join('\n')).toBe(0);
    const request = join(dev, 'state', 'restore-requests', `${RESTORE}.json`);
    expect(JSON.parse(readFileSync(request, 'utf8'))).toEqual(restoreInput());
    expect(statSync(request).mode & 0o777).toBe(0o600);
    expect(calls('systemctl').map((c) => c.args)).toEqual([
      ['start', '--no-block', `ilex-restore@${RESTORE}.service`],
    ]);
    expect(calls('borg')).toEqual([]);
  });

  it('back where it was: stops the app, sets the current folders aside, extracts, starts it again', async () => {
    const result = await restore(restoreInput());
    expect(result.code, result.lines.join('\n')).toBe(0);
    expect(
      events()
        .filter((e) => e.type === 'phase')
        .map((e) => e.phase),
    ).toEqual(['stopping', 'restoring', 'starting', 'done']);
    const data = join(storage, 'demo', 'data');
    const setAside = done()!.setAside as string[];
    // It ran before: the app offers to apply the restored settings.
    expect(done()).toMatchObject({ status: 'succeeded', errorCode: null, appWasRunning: true });
    expect(setAside).toHaveLength(2);
    expect(setAside[0]).toMatch(new RegExp(`^${data}\\.before-restore-\\d{8}-\\d{6}$`));
    // The previous version is kept whole; the folder now holds the restored data.
    expect(readFileSync(join(setAside[0], 'db.sqlite'), 'utf8')).toBe('data');
    expect(existsSync(join(data, 'restored.txt'))).toBe(true);
    const extract = calls('borg').find((c) => c.args[0] === 'extract')!;
    expect(extract.cwd).toBe('/');
    expect(extract.args).toEqual([
      'extract',
      '--log-json',
      '--numeric-ids',
      `${join(destination, 'ilex-backups')}::${archive}`,
      data.slice(1),
      join(storage, 'demo', 'media').slice(1),
    ]);
    // Started as it was: never `up` with files as root.
    expect(calls('docker').map((c) => c.args)).toEqual([
      ['compose', '-p', 'demo', 'ps', '-q'],
      ['compose', '-p', 'demo', 'stop'],
      ['compose', '-p', 'demo', 'start'],
    ]);
    // The request is gone once done.
    expect(existsSync(join(dev, 'state', 'restore-requests', `${RESTORE}.json`))).toBe(false);
  });

  it('puts everything back when the extraction fails', async () => {
    writeFileSync(join(dir, 'exit-extract.txt'), '2');
    const result = await restore(restoreInput());
    expect(result.code).toBe(5);
    expect(done()).toMatchObject({ status: 'failed', setAside: [], appWasRunning: false });
    const data = join(storage, 'demo', 'data');
    expect(readFileSync(join(data, 'db.sqlite'), 'utf8')).toBe('data');
    expect(existsSync(join(data, 'partial.txt'))).toBe(false);
    expect(readFileSync(join(dev, 'state', 'set-aside.json'), 'utf8')).toBe('[]\n');
    expect(calls('docker').map((c) => c.args[3])).toEqual(['ps', 'stop', 'start']);
  });

  it('a restore killed during the extraction has already said where the previous version is', async () => {
    writeFileSync(join(dir, 'kill-extract.txt'), '');
    const result = await restore(restoreInput());
    expect(result.code).not.toBe(0);
    expect(done()).toBeUndefined();
    const setAside = events().findLast((e) => e.type === 'setAside')!.setAside as string[];
    expect(setAside).toHaveLength(2);
    expect(readFileSync(join(setAside[0], 'db.sqlite'), 'utf8')).toBe('data');
    // The same as the program's own list, which `discard` goes by.
    const list = JSON.parse(readFileSync(join(dev, 'state', 'set-aside.json'), 'utf8'));
    expect(list.map((e: any) => e.path)).toEqual(setAside);
  });

  it('restored, but the app won’t start again: a failure that still reports the previous version', async () => {
    writeFileSync(join(dir, 'exit-start.txt'), '1');
    const result = await restore(restoreInput());
    expect(result.code).toBe(5);
    expect(done()).toMatchObject({ status: 'failed', errorCode: 'service_not_restarted' });
    expect(done()!.setAside).toHaveLength(2);
    expect(existsSync(join(storage, 'demo', 'data', 'restored.txt'))).toBe(true);
  });

  it('a failed extraction says the set-aside folders went back', async () => {
    writeFileSync(join(dir, 'exit-extract.txt'), '2');
    await restore(restoreInput());
    const said = events()
      .filter((e) => e.type === 'setAside')
      .map((e) => (e.setAside as string[]).length);
    expect(said).toEqual([1, 2, 1, 0]);
  });

  it('only the folders in the plan now: one taken out is left alone, one the backup lacks is said', async () => {
    const data = join(storage, 'demo', 'data');
    const media = join(storage, 'demo', 'media');
    const extra = join(storage, 'demo', 'extra');
    const items = plan().items.map((i: any) =>
      i.id === SERVICE ? { ...i, folders: [data, extra], skip: [] } : i,
    );
    expect((await wrapper('configure', plan({ items }))).code).toBe(0);
    const result = await restore(restoreInput());
    expect(result.code, result.lines.join('\n')).toBe(0);
    expect(done()!.setAside).toEqual([expect.stringMatching(new RegExp(`^${data}\\.before`))]);
    expect(
      calls('borg')
        .find((c) => c.args[0] === 'extract')!
        .args.slice(-1),
    ).toEqual([data.slice(1)]);
    expect(existsSync(join(media, 'restored.txt'))).toBe(false);
    expect(JSON.stringify(events())).toContain(`${extra}: not in this backup, left as it is`);
  });

  it('a folder of the archive the plan no longer has is never checked or touched', async () => {
    const data = join(storage, 'demo', 'data');
    const archives = JSON.parse(readFileSync(join(dir, 'archives.json'), 'utf8'));
    const line: string[] = archives[archive];
    const at = line.indexOf('--comment');
    // The archive also lists a folder that may not be restored now (and isn't in the plan).
    line[at + 1] = JSON.stringify([...JSON.parse(line[at + 1]), '/etc/old']);
    writeFileSync(join(dir, 'archives.json'), JSON.stringify(archives));
    const result = await restore(restoreInput());
    expect(result.code, result.lines.join('\n')).toBe(0);
    expect(done()!.setAside).toHaveLength(2);
    expect(calls('borg').find((c) => c.args[0] === 'extract')!.args).toContain(data.slice(1));
  });

  it('an archive that doesn’t list its folders: refused back where it was, fine into a folder', async () => {
    const archives = JSON.parse(readFileSync(join(dir, 'archives.json'), 'utf8'));
    for (const name of Object.keys(archives)) {
      const line: string[] = archives[name];
      const at = line.indexOf('--comment');
      if (at >= 0) line.splice(at, 2);
    }
    writeFileSync(join(dir, 'archives.json'), JSON.stringify(archives));
    expect((await restore(restoreInput())).code).toBe(5);
    expect(done()).toMatchObject({ status: 'failed', errorCode: 'archive_not_found' });
    expect(calls('docker')).toEqual([]);
    rmSync(jobFile(RESTORE));
    const target = join(dir, 'restored');
    const result = await restore(restoreInput({ target }));
    expect(result.code, result.lines.join('\n')).toBe(0);
    expect(done()).toMatchObject({ status: 'succeeded' });
  });

  it('into a chosen folder: everything with its full paths, nothing stopped', async () => {
    const target = join(dir, 'restored');
    const result = await restore(restoreInput({ itemId: FOLDER, archive: folderArchive, target }));
    expect(result.code, result.lines.join('\n')).toBe(0);
    expect(done()).toMatchObject({ status: 'succeeded', setAside: [], appWasRunning: false });
    expect(existsSync(join(target, join(storage, 'docs').slice(1), 'restored.txt'))).toBe(true);
    expect(calls('borg').find((c) => c.args[0] === 'extract')!.cwd).toBe(target);
    expect(calls('docker')).toEqual([]);
  });

  it('refuses a chosen folder that has something in it', async () => {
    const target = join(storage, 'docs');
    writeFileSync(join(target, 'mine.txt'), 'x');
    const result = await restore(restoreInput({ itemId: FOLDER, archive: folderArchive, target }));
    expect(result.code).toBe(2);
    expect(done()).toMatchObject({ status: 'failed', errorCode: 'target_not_empty' });
  });

  it('the platform only into a folder', async () => {
    expectRefused(
      await wrapper(
        'restore-start',
        restoreInput({ itemId: PLATFORM, archive: archive.replace(SERVICE, PLATFORM) }),
      ),
      'invalid_request',
    );
  });

  it('refuses an archive of another item, a name that is not one of ours, a system folder', async () => {
    expectRefused(
      await wrapper('restore-start', restoreInput({ archive: folderArchive })),
      'invalid_request',
    );
    expectRefused(
      await wrapper('restore-start', restoreInput({ archive: `${SERVICE}-latest` })),
      'invalid_request',
    );
    expectRefused(
      await wrapper('restore-start', restoreInput({ target: '/etc' })),
      'path_not_allowed',
    );
    expectRefused(await wrapper('restore-start', restoreInput({ path: '/' })), 'invalid_request');
    expect(calls('systemctl')).toEqual([]);
  });

  it('a run without its request (or another restore’s) does nothing', async () => {
    const result = await wrapper(['restore-run', RESTORE]);
    expect(result.code).toBe(2);
    expect(done()).toMatchObject({ status: 'failed', errorCode: 'not_found' });
    expect(calls('borg')).toEqual([]);
  });

  it('reports an archive that is gone', async () => {
    const gone = `${SERVICE}-2020-01-01T00:00:00`;
    const result = await restore(restoreInput({ archive: gone }));
    expect(result.code).toBe(5);
    expect(done()).toMatchObject({ status: 'failed', errorCode: 'archive_not_found' });
  });
});

describe('ilex-backup discard, forget and passphrase', () => {
  beforeEach(async () => {
    await setUp();
    await runNow({ runId: RUN });
  });

  it('discard deletes a folder a restore set aside — and nothing else', async () => {
    const archive = results()[0].items.find((i: any) => i.itemId === SERVICE).archive;
    useSystemctl();
    await wrapper('restore-start', { restoreId: RESTORE, itemId: SERVICE, archive, target: null });
    await wrapper(['restore-run', RESTORE]);
    const done = job(RESTORE).find((e) => e.type === 'restoreDone');
    const [first] = done!.setAside as string[];
    expect((await wrapper('discard', { path: first })).code).toBe(0);
    expect(existsSync(first)).toBe(false);
    // Not listed (any more), or not a set-aside name: refused.
    expectRefused(await wrapper('discard', { path: first }), 'not_found');
    expectRefused(await wrapper('discard', { path: join(storage, 'docs') }), 'invalid_request');
    expectRefused(
      await wrapper('discard', { path: '/etc.before-restore-20260101-000000' }),
      'not_found',
    );
    expect(existsSync(join(storage, 'docs'))).toBe(true);
  });

  it('forget deletes the archives of a removed item only', async () => {
    expectRefused(await wrapper('forget', { itemId: FOLDER }), 'invalid_request');
    expectRefused(await wrapper('forget', { itemId: PLATFORM }), 'invalid_request');
    const items = plan().items.map((i: any) => (i.id === FOLDER ? { ...i, removed: true } : i));
    await wrapper('configure', plan({ items }));
    resetCalls();
    expect((await wrapper('forget', { itemId: FOLDER })).code).toBe(0);
    expect(calls('borg').map((c) => c.args)).toEqual([
      ['delete', '--log-json', '--glob-archives', `${FOLDER}-*`, join(destination, 'ilex-backups')],
      ['compact', '--log-json', join(destination, 'ilex-backups')],
    ]);
  });

  it('passphrase shows it (the only action that does)', async () => {
    const result = await wrapper('passphrase');
    expect(result.code).toBe(0);
    expect(result.result).toEqual({ passphrase: passphrase() });
  });
});

describe('ilex-backup check-scheduled', () => {
  beforeEach(() => setUp());

  it('checks the repository and records the result', async () => {
    expect((await wrapper('check-scheduled')).code).toBe(0);
    expect(borgCommands()).toEqual(['check']);
    expect(results()[0]).toMatchObject({ type: 'check', status: 'ok', errorCode: null });
  });

  it('reports damage', async () => {
    writeFileSync(join(dir, 'exit-check.txt'), '1');
    expect((await wrapper('check-scheduled')).code).toBe(5);
    expect(results()[0]).toMatchObject({
      type: 'check',
      status: 'failed',
      errorCode: 'repository_damaged',
    });
  });
});

describe('ilex-backup and the platform’s folders', () => {
  it('never backs up the platform’s own folders, nor a folder holding them', async () => {
    for (const path of [
      join(storage, 'platform'),
      join(storage, 'platform', 'x'),
      '/var/lib/ilex/backups',
    ]) {
      const items = [plan().items[0], { id: RUN, kind: 'folder', path }];
      expectRefused(await wrapper('configure', plan({ items })), 'invalid_plan');
    }
  });
});

describe('ilex-backup start ("Back up now")', () => {
  const unitCalls = () => calls('systemctl').filter((c) => c.args[0] === 'start');

  it('starts the run as its own systemd unit and returns at once', async () => {
    useSystemctl();
    await setUp();
    const result = await wrapper('start', { runId: RUN, itemId: FOLDER });
    expect(result.code, result.lines.join('\n')).toBe(0);
    expect(result.result).toEqual({ started: true });
    expect(unitCalls().map((c) => c.args)).toEqual([
      ['start', '--no-block', `ilex-backup-now@${RUN}_${FOLDER}.service`],
    ]);
    expect(Object.keys(unitCalls()[0].env).sort()).toEqual(['HOME', 'PATH']);
    await wrapper('start', { runId: RUN });
    expect(unitCalls().at(-1)!.args[2]).toBe(`ilex-backup-now@${RUN}.service`);
    // systemd runs it, not this call.
    expect(calls('borg')).toEqual([]);
  });

  it('refuses at once what would refuse the run: no plan, an unknown or removed item, bad input', async () => {
    useSystemctl();
    expectRefused(await wrapper('start', { runId: RUN }), 'not_configured', 6);
    await setUp();
    expectRefused(await wrapper('start', { runId: RUN, itemId: RESTORE }), 'item_not_found');
    const items = plan().items.map((i: any) => (i.id === FOLDER ? { ...i, removed: true } : i));
    await wrapper('configure', plan({ items }));
    expectRefused(await wrapper('start', { runId: RUN, itemId: FOLDER }), 'item_not_found');
    expectRefused(await wrapper('start', { runId: 'x' }), 'invalid_request');
    expectRefused(await wrapper('start', { runId: RUN, itemId: '../x' }), 'invalid_request');
    expectRefused(await wrapper('start', { runId: RUN, extra: 1 }), 'invalid_request');
    expectRefused(await wrapper('start', 'nope'), 'invalid_request');
    expect(unitCalls()).toEqual([]);
  });

  it('reports systemd refusing to start it', async () => {
    useSystemctl();
    await setUp();
    writeFileSync(join(dir, 'exit-systemctl.txt'), '1');
    expectRefused(await wrapper('start', { runId: RUN }), 'setup', 6);
  });

  it('in development (no systemd), runs it detached: it finishes after the caller is gone', async () => {
    await setUp();
    const result = await wrapper('start', { runId: RUN, itemId: FOLDER });
    expect(result.code, result.lines.join('\n')).toBe(0);
    const deadline = Date.now() + 20_000;
    while (!results().some((r) => r.runId === RUN) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(results().find((r) => r.runId === RUN)).toMatchObject({
      trigger: 'manual',
      itemId: FOLDER,
      status: 'ok',
    });
    expect(readFileSync(join(dev, 'state', 'requested-run.log'), 'utf8')).toContain('@@result');
  });

  it('records a run whose item was removed after it was started', async () => {
    await setUp();
    expectRefused(await runNow({ runId: RUN, itemId: RESTORE }), 'item_not_found');
    expect(results()).toEqual([
      expect.objectContaining({ runId: RUN, status: 'failed', errorCode: 'item_not_found' }),
    ]);
  });
});
