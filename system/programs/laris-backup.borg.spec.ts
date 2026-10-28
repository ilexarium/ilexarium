// The backup wrapper against the real Borg (development mode, a fake `docker`): back up a
// service and a folder to a temporary "disk", prune, restore in place and to a new folder, check,
// forget. Skipped where Borg isn't installed. Run by the server's unit tests.
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = fileURLToPath(new URL('./laris-backup.mts', import.meta.url));
const FAKE_DOCKER = fileURLToPath(new URL('./testing/fake-docker.cjs', import.meta.url));
const BORG = ['/usr/bin/borg', '/usr/local/bin/borg'].find((p) => existsSync(p));

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const SERVICE = '22222222-2222-4222-8222-222222222222';
const FOLDER = '44444444-4444-4444-8444-444444444444';

let dir: string;
let storage: string;
let destination: string;
let dev: string;

function wrapper(
  action: string | string[],
  input: unknown = '',
): Promise<{ code: number | null; out: string; result: any }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRAPPER, ...[action].flat()], {
      env: { LARIS_WRAPPER_CONFIG: join(dir, 'wrappers.json') },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    child.on('close', (code) => {
      const line = out.split('\n').findLast((l) => l.startsWith('@@result '));
      resolve({ code, out, result: line ? JSON.parse(line.slice(9)) : null });
    });
  });
}

const runs = () =>
  readFileSync(join(dev, 'state', 'runs.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe.skipIf(!BORG)('laris-backup with the real Borg', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'backup-borg-'));
    chmodSync(dir, 0o755);
    storage = join(dir, 'storage');
    dev = join(dir, 'dev');
    destination = join(dir, 'mnt', 'usb');
    mkdirSync(join(storage, 'demo', 'data', 'cache'), { recursive: true });
    mkdirSync(join(storage, 'docs'), { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(storage, 'demo', 'data', 'db.sqlite'), 'version 1');
    writeFileSync(join(storage, 'demo', 'data', 'cache', 'big.bin'), 'rebuilt by the service');
    writeFileSync(join(storage, 'docs', 'letter.txt'), 'Dear …');
    writeFileSync(join(storage, 'docs', 'private.txt'), 'only mine', { mode: 0o600 });
    mkdirSync(join(dir, 'etc'));
    writeFileSync(join(dir, 'etc', 'master.key'), 'key');
    mkdirSync(join(dir, 'catalog', 'demo'), { recursive: true });
    writeFileSync(
      join(dir, 'catalog', 'demo', 'meta.json'),
      JSON.stringify({
        id: 'demo',
        fields: [{ key: 'DATA_DIR', type: 'path', default: '/x', access: 'write' }],
        backup: { folders: [{ field: 'DATA_DIR', skip: ['cache'] }], mode: 'stop' },
      }),
    );
    writeFileSync(
      join(dir, 'docker'),
      `#!${process.execPath}\n${readFileSync(FAKE_DOCKER, 'utf8')}`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(join(dir, 'running.txt'), 'hl-demo');
    writeFileSync(join(dir, 'mountinfo'), `100 30 8:17 / ${destination} rw - ext4 /dev/sdb1 rw\n`);
    writeFileSync(
      join(dir, 'wrappers.json'),
      JSON.stringify({
        catalogDir: join(dir, 'catalog'),
        storageRoots: [storage],
        serviceRoot: storage,
        reservedPorts: [],
        protectedPaths: [],
        dockerBin: join(dir, 'docker'),
        lockFile: join(dir, 'compose.lock'),
        home: dir,
        backup: {
          borgBin: BORG,
          platform: {
            container: 'db',
            database: 'laris',
            user: 'laris',
            files: [join(dir, 'etc', 'master.key')],
          },
          dev: {
            dir: dev,
            destinationRoots: [join(dir, 'mnt')],
            mountInfo: join(dir, 'mountinfo'),
            retryDelayMs: 10,
          },
        },
      }),
    );
    const plan = {
      destination,
      schedule: { frequency: 'daily', time: '03:00' },
      retention: { daily: 1, weekly: 0, monthly: 0 },
      items: [
        { id: PLATFORM, kind: 'platform' },
        {
          id: SERVICE,
          kind: 'service',
          catalogId: 'demo',
          folders: { DATA_DIR: join(storage, 'demo', 'data') },
        },
        { id: FOLDER, kind: 'folder', path: join(storage, 'docs') },
      ],
    };
    expect((await wrapper('configure', plan)).code).toBe(0);
    const init = await wrapper('init', { destination });
    expect(init.code, init.out).toBe(0);
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('backs everything up, skipping what the recipe says; pruning keeps one a day', async () => {
    const first = await wrapper(['run-requested', '55555555-5555-4555-8555-555555555551']);
    expect(first.code, first.out).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // a new archive name (one per second)
    writeFileSync(join(storage, 'demo', 'data', 'db.sqlite'), 'version 2');
    const second = await wrapper(['run-requested', '55555555-5555-4555-8555-555555555552']);
    expect(second.code, second.out).toBe(0);
    const items = runs()[1].items;
    expect(items.map((i: any) => i.status)).toEqual(['ok', 'ok', 'ok']);
    // keep-daily 1: only today's latest archive of each item is left.
    for (const item of items) expect(item.archives).toEqual([item.archive]);
    expect(runs()[0].items[0].originalBytes).toBeGreaterThan(0);
  }, 60_000);

  it('restores a service in place, the current version set aside, without what was skipped', async () => {
    const archive = runs()[1].items[1].archive;
    writeFileSync(join(storage, 'demo', 'data', 'db.sqlite'), 'broken');
    const result = await wrapper('restore', {
      restoreId: '66666666-6666-4666-8666-666666666661',
      itemId: SERVICE,
      archive,
      target: 'inPlace',
    });
    expect(result.code, result.out).toBe(0);
    expect(readFileSync(join(storage, 'demo', 'data', 'db.sqlite'), 'utf8')).toBe('version 2');
    expect(existsSync(join(storage, 'demo', 'data', 'cache'))).toBe(false);
    const [setAside] = result.result.setAside;
    expect(readFileSync(join(setAside, 'db.sqlite'), 'utf8')).toBe('broken');
    expect(readFileSync(join(dir, 'running.txt'), 'utf8')).toContain('hl-demo');

    expect((await wrapper('discard', { path: setAside })).code).toBe(0);
    expect(existsSync(setAside)).toBe(false);
  }, 60_000);

  it('restores a folder to a new folder, with its full path below it', async () => {
    const archive = runs()[1].items[2].archive;
    const result = await wrapper('restore', {
      restoreId: '66666666-6666-4666-8666-666666666662',
      itemId: FOLDER,
      archive,
      target: 'newFolder',
    });
    expect(result.code, result.out).toBe(0);
    const target: string = result.result.targetPath;
    const restored = join(target, join(storage, 'docs').slice(1), 'letter.txt');
    expect(readFileSync(restored, 'utf8')).toBe('Dear …');
    // Every folder from the restore area down to the restored one can be passed through
    // (0755) — the person can reach their files — while each file keeps its own mode.
    const mode = (path: string) => statSync(path).mode & 0o777;
    for (
      let folder = dirname(restored);
      folder.length >= dirname(target).length;
      folder = dirname(folder)
    ) {
      expect(mode(folder), folder).toBe(0o755);
    }
    expect(mode(join(dirname(restored), 'private.txt'))).toBe(0o600);
  }, 60_000);

  it('the platform archive holds the dump and the platform files', async () => {
    const archive = runs()[1].items[0].archive;
    const result = await wrapper('restore', {
      restoreId: '66666666-6666-4666-8666-666666666663',
      itemId: PLATFORM,
      archive,
      target: 'newFolder',
    });
    expect(result.code, result.out).toBe(0);
    const target = result.result.targetPath;
    expect(readFileSync(join(target, join(dir, 'etc', 'master.key').slice(1)), 'utf8')).toBe('key');
    const dumps = readdirSync(join(target, join(dev, 'state', 'platform').slice(1)));
    expect(dumps).toEqual(['laris.dump']);
  }, 60_000);

  it('checks the repository', async () => {
    expect((await wrapper('check-scheduled')).code).toBe(0);
    expect(runs().at(-1)).toMatchObject({ type: 'check', status: 'ok' });
  }, 120_000);

  it('a wrong passphrase fails the run without writing', async () => {
    const file = join(dev, 'backup.passphrase');
    const saved = readFileSync(file, 'utf8');
    chmodSync(file, 0o600);
    writeFileSync(file, 'wrong words\n');
    const result = await wrapper([
      'run-requested',
      `55555555-5555-4555-8555-555555555553_${FOLDER}`,
    ]);
    expect(result.code).toBe(5);
    expect(runs().at(-1)).toMatchObject({
      status: 'failed',
      items: [{ errorCode: 'passphrase_invalid' }],
    });
    writeFileSync(file, saved);
  }, 60_000);

  it('forgets a removed item’s archives', async () => {
    const plan = JSON.parse(readFileSync(join(dev, 'backup.json'), 'utf8'));
    plan.items[2].removed = true;
    expect((await wrapper('configure', plan)).code).toBe(0);
    const forgotten = await wrapper('forget', { itemId: FOLDER });
    expect(forgotten.code, forgotten.out).toBe(0);
    const again = await wrapper('restore', {
      restoreId: '66666666-6666-4666-8666-666666666664',
      itemId: FOLDER,
      archive: runs()[1].items[2].archive,
      target: 'newFolder',
    });
    expect(again.out).toContain('@@error code=archive_not_found');
  }, 60_000);
});
