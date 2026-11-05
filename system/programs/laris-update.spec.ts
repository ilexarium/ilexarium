// Tests for the update program (laris-update.mts) — run in development mode (not root), against a
// pretend machine under a temporary folder, releases served over HTTP on 127.0.0.1 (signed with a
// test key), a fake installer inside each release archive, and fake systemctl and docker
// (testing/fake-program.cjs). Run by the server's unit tests.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicKeyFile, signatureFile } from '../../scripts/lib/minisign.mjs';
import { healthUrlOf } from './update/config.mts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROGRAM = join(HERE, 'laris-update.mts');
const DUMP = '/var/lib/laris/install-backups/laris-0.1.0-20261104-120000.dump';

let dir: string;
let root: string;
let server: Server;
let port: number;
let files: Map<string, Buffer>;
let healthVersion: string;
const releaseKey = generateKeyPairSync('ed25519');

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', version: healthVersion }));
      return;
    }
    const body = files.get(req.url ?? '');
    res.statusCode = body ? 200 : 404;
    res.end(body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'laris-update-'));
  root = join(dir, 'root');
  files = new Map();
  healthVersion = '0.1.0';
  for (const folder of [
    'etc/laris',
    'etc/systemd/system',
    'opt/laris/app',
    'var/lib/laris/install-backups',
    'bin',
  ]) {
    mkdirSync(join(root, folder), { recursive: true });
  }
  writeFileSync(join(root, 'etc/laris/version'), '0.1.0\n');
  writeFileSync(
    join(root, 'etc/laris/release.env'),
    `RELEASE_URL=http://127.0.0.1:${port}/releases\n`,
  );
  writeFileSync(join(root, 'etc/laris/release.pub'), publicKeyFile(releaseKey.publicKey));
  writeFileSync(join(root, 'etc/systemd/system/laris.service'), 'old unit\n');
  writeFileSync(join(root, 'opt/laris/app/marker'), 'old\n');

  mkdirSync(join(dir, 'bin'));
  for (const name of ['systemctl', 'docker', 'systemd-tmpfiles']) {
    const path = join(dir, 'bin', name);
    writeFileSync(
      path,
      `#!/usr/bin/env node\n${readFileSync(join(HERE, 'testing/fake-program.cjs'), 'utf8')}`,
    );
    chmodSync(path, 0o755);
  }
  for (const name of ['tar', 'bash', 'cp']) symlinkSync(`/usr/bin/${name}`, join(dir, 'bin', name));
  writeFileSync(
    join(dir, 'wrappers.json'),
    JSON.stringify({
      update: {
        dev: { root, bin: join(dir, 'bin'), healthUrl: `http://127.0.0.1:${port}/api/health` },
      },
    }),
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A fake installer, like install.sh --update: its @@ lines, keeping the installed version first;
// files in the pretend root make it fail at a step.
function installer(version: string): string {
  return `#!/usr/bin/env bash
set -e
R='${root}'
echo "@@phase checked"
if [[ -f "$R/fail-checks" ]]; then echo 'Needed first: Node.js 24'; exit 1; fi
P="$R/opt/laris/previous"
mkdir -p "$P/files/etc/systemd/system" "$P/files/etc/laris"
cp -a "$R/opt/laris/app" "$P/app"
cp -a "$R/etc/systemd/system/laris.service" "$P/files/etc/systemd/system/"
cp -a "$R/etc/laris/version" "$R/etc/laris/release.env" "$R/etc/laris/release.pub" "$P/files/etc/laris/"
cat "$R/kept-version" 2>/dev/null >"$P/VERSION" || echo 0.1.0 >"$P/VERSION"
echo "@@phase saved"
echo "@@phase stopped"
echo 'the dump' >"$R${DUMP}"
echo "@@dump ${DUMP}"
echo 'new unit' >"$R/etc/systemd/system/laris.service"
echo 'added' >"$R/etc/systemd/system/laris-added.service"
echo "@@phase migrated"
if [[ -f "$R/fail-install" ]]; then echo 'Something failed'; exit 1; fi
echo new >"$R/opt/laris/app/marker"
echo ${version} >"$R/etc/laris/version"
echo "@@phase installed"
echo "@@phase started"
`;
}

interface Release {
  version?: string;
  key?: KeyObject;
  manifest?: (m: Record<string, unknown>) => Record<string, unknown>;
  archiveVersion?: string;
}

/** Builds and serves a release: its archive (with the fake installer), manifest and signature. */
function publish({
  version = '0.2.0',
  key = releaseKey.privateKey,
  manifest,
  archiveVersion,
}: Release = {}) {
  const shipped = archiveVersion ?? version;
  const stage = join(dir, 'stage', `laris-${version}`);
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, 'VERSION'), `${shipped}\n`);
  writeFileSync(join(stage, 'install.sh'), installer(version), { mode: 0o755 });
  const archive = join(dir, `laris-${version}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', join(dir, 'stage'), `laris-${version}`]);
  const bytes = readFileSync(archive);
  let fields: Record<string, unknown> = {
    version,
    published: '2026-11-20T10:00:00Z',
    archive: `laris-${version}.tar.gz`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
  if (manifest) fields = manifest(fields);
  const manifestBytes = Buffer.from(`${JSON.stringify(fields, null, 2)}\n`);
  const base = `/releases/download/v${version}`;
  files.set(`${base}/manifest.json`, manifestBytes);
  files.set(
    `${base}/manifest.json.minisig`,
    Buffer.from(signatureFile(key, manifestBytes, 'manifest.json')),
  );
  files.set(`${base}/laris-${version}.tar.gz`, bytes);
}

function program(args: string[], input = ''): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROGRAM, ...args], {
      env: { PATH: '/usr/bin:/bin', LARIS_WRAPPER_CONFIG: join(dir, 'wrappers.json') },
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stdin.end(input);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const jobOf = (id: string) =>
  readFileSync(join(root, 'var/lib/laris/updates', `${id}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, any>);

/** Starts an update (the run goes on detached, as without systemd) and waits for its end. */
async function update(version = '0.2.0') {
  const id = randomUUID();
  const started = await program(['start'], JSON.stringify({ updateId: id, version }));
  expect(started.out).toContain('@@result');
  for (let i = 0; i < 300; i++) {
    const done = jobOf(id).find((event) => event.type === 'done');
    if (done) {
      // Cleaned up and unlocked by the time its end is written.
      expect(existsSync(join(root, 'var/lib/laris/updates', id))).toBe(false);
      expect(existsSync(join(root, 'root.lock'))).toBe(false);
      return { id, done, events: jobOf(id) };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `no end: ${readFileSync(join(root, 'var/lib/laris/updates', `${id}.log`), 'utf8')}`,
  );
}

const calls = (name: string) =>
  existsSync(join(dir, `${name}-calls.jsonl`))
    ? readFileSync(join(dir, `${name}-calls.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { args: string[]; input: string })
    : [];
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('laris-update start', () => {
  const start = (input: object) => program(['start'], JSON.stringify(input));

  it('refuses an older or the same version', async () => {
    for (const version of ['0.1.0', '0.0.9']) {
      const { code, out } = await start({ updateId: randomUUID(), version });
      expect(code).toBe(2);
      expect(out).toContain('@@error code=not_newer');
    }
  });

  it('takes only an update id and a version — no address, no file', async () => {
    for (const input of [
      { updateId: 'x', version: '0.2.0' },
      { updateId: randomUUID(), version: '0.2' },
      { updateId: randomUUID(), version: '0.2.0', url: 'https://elsewhere' },
    ]) {
      expect((await start(input)).out).toContain('@@error code=invalid_request');
    }
  });

  it('is refused while another root operation holds the lock', async () => {
    writeFileSync(join(root, 'root.lock'), String(process.pid));
    const { code, out } = await start({ updateId: randomUUID(), version: '0.2.0' });
    expect(code).toBe(3);
    expect(out).toContain('@@error code=busy');
  });

  it('is refused while another update is starting, not after its request went stale', async () => {
    const state = join(root, 'var/lib/laris/updates');
    mkdirSync(state, { recursive: true });
    const stale = join(state, `${randomUUID()}.request`);
    writeFileSync(stale, '{}');
    expect((await start({ updateId: randomUUID(), version: '0.2.0' })).out).toContain(
      '@@error code=busy',
    );
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(stale, old, old);
    publish();
    const { out } = await start({ updateId: randomUUID(), version: '0.2.0' });
    expect(out).toContain('@@result');
    expect(existsSync(stale)).toBe(false);
  });

  it('needs an update source', async () => {
    rmSync(join(root, 'etc/laris/release.pub'));
    expect((await start({ updateId: randomUUID(), version: '0.2.0' })).out).toContain(
      '@@error code=not_configured',
    );
  });
});

// Each update spawns the program, its detached run, the installer and the fakes: slow on a busy machine.
describe('laris-update run', { timeout: 30_000 }, () => {
  it('updates: checked, downloaded, installed, answering as the new version', async () => {
    publish();
    healthVersion = '0.2.0';
    const { id, done, events } = await update();
    expect(done).toMatchObject({ outcome: 'updated', version: '0.2.0' });
    expect(events.filter((e) => e.type === 'phase').map((e) => e.phase)).toEqual([
      'check',
      'download',
      'unpack',
      'install',
      'checked',
      'saved',
      'stopped',
      'migrated',
      'installed',
      'started',
      'health',
    ]);
    expect(read('opt/laris/app/marker')).toBe('new\n');
    expect(calls('docker')).toEqual([]);
    // The app's group follows it.
    expect(statSync(join(root, 'var/lib/laris/updates', `${id}.jsonl`)).mode & 0o777).toBe(0o640);
    expect(statSync(join(root, 'var/lib/laris/updates')).mode & 0o777).toBe(0o750);
    expect(existsSync(join(root, 'var/lib/laris/updates', id))).toBe(false);
    expect(existsSync(join(root, 'var/lib/laris/updates', `${id}.request`))).toBe(false);
  });

  it.each<[string, Release, string]>([
    [
      'a manifest signed by another key',
      { key: generateKeyPairSync('ed25519').privateKey },
      'bad_signature',
    ],
    [
      'a wrong fingerprint',
      { manifest: (m) => ({ ...m, sha256: '0'.repeat(64) }) },
      'wrong_checksum',
    ],
    [
      'an archive larger than its manifest says',
      { manifest: (m) => ({ ...m, size: (m['size'] as number) - 10 }) },
      'too_large',
    ],
    [
      'an archive address in the manifest',
      { manifest: (m) => ({ ...m, archive: 'https://elsewhere/x.tar.gz' }) },
      'bad_manifest',
    ],
    [
      'a manifest for another version',
      { manifest: (m) => ({ ...m, version: '0.3.0' }) },
      'bad_manifest',
    ],
    ['an archive holding another version', { archiveVersion: '0.3.0' }, 'bad_manifest'],
  ])('refuses %s before running anything from it', async (_, release, error) => {
    publish(release);
    const { done } = await update();
    expect(done).toMatchObject({ outcome: 'failed', version: '0.1.0', error });
    expect(read('opt/laris/app/marker')).toBe('old\n');
    expect(calls('systemctl')).toEqual([]);
  });

  it('a missing release: failed, nothing changed', async () => {
    const { done } = await update();
    expect(done).toMatchObject({ outcome: 'failed', error: 'download_failed' });
  });

  it('a missing prerequisite stops it before anything changed: the app runs again', async () => {
    publish();
    writeFileSync(join(root, 'fail-checks'), '');
    const { done, events } = await update();
    expect(done).toMatchObject({ outcome: 'failed', version: '0.1.0', error: 'install_failed' });
    expect(events.some((e) => e.type === 'line' && e.text === 'Needed first: Node.js 24')).toBe(
      true,
    );
    expect(events.some((e) => e.phase === 'rollback')).toBe(false);
    expect(calls('systemctl').map((c) => c.args)).toEqual([['start', 'laris.service']]);
  });

  it('rolls back after a failed install: files, units, settings and the database as they were', async () => {
    publish();
    writeFileSync(join(root, 'fail-install'), '');
    const { done, events } = await update();
    expect(done).toMatchObject({
      outcome: 'rolled_back',
      version: '0.1.0',
      error: 'install_failed',
    });
    expect(events.some((e) => e.phase === 'rollback')).toBe(true);
    expect(read('opt/laris/app/marker')).toBe('old\n');
    expect(read('etc/systemd/system/laris.service')).toBe('old unit\n');
    expect(existsSync(join(root, 'etc/systemd/system/laris-added.service'))).toBe(false);
    expect(read('etc/laris/version')).toBe('0.1.0\n');

    const docker = calls('docker');
    expect(docker.find((c) => c.args.includes('psql'))?.input).toBe(
      'DROP SCHEMA public CASCADE;\nCREATE SCHEMA public;\n',
    );
    const restore = docker.find((c) => c.args.includes('pg_restore'));
    expect(restore?.args).toEqual([
      'exec',
      '-i',
      'laris-postgres-1',
      'pg_restore',
      '--exit-on-error',
      '-U',
      'laris_owner',
      '-d',
      'laris',
    ]);
    expect(restore?.input).toBe('the dump\n');
    expect(calls('systemctl').map((c) => c.args)).toEqual([
      ['stop', 'laris.service'],
      ['daemon-reload'],
      ['restart', 'laris-platform.service'],
      ['reload-or-restart', 'ssh.service'],
      ['start', 'laris.service'],
    ]);
  });

  it('a machine without its version file: the job still gets its end', async () => {
    const id = randomUUID();
    const state = join(root, 'var/lib/laris/updates');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, `${id}.request`), JSON.stringify({ version: '0.2.0' }));
    writeFileSync(join(state, `${id}.jsonl`), '');
    rmSync(join(root, 'etc/laris/version'));
    const { code } = await program(['run', id]);
    expect(code).toBe(5);
    expect(jobOf(id).at(-1)).toMatchObject({ type: 'done', outcome: 'failed', error: 'setup' });
  });

  it('puts nothing back from a kept copy of another version', async () => {
    publish();
    writeFileSync(join(root, 'fail-install'), '');
    writeFileSync(join(root, 'kept-version'), '0.0.1\n');
    const { done } = await update();
    expect(done).toMatchObject({ outcome: 'rollback_failed', version: '0.2.0' });
    expect(calls('docker')).toEqual([]);
  });
});

describe('the health URL, from the machine’s app settings', () => {
  it('HOST and PORT, the app’s defaults without them', () => {
    expect(healthUrlOf('')).toBe('http://127.0.0.1:3000/api/health');
    expect(
      healthUrlOf('DATABASE_URL=postgresql://laris:pw@127.0.0.1:5432/laris\nPORT=8080\n'),
    ).toBe('http://127.0.0.1:8080/api/health');
    expect(healthUrlOf('HOST=192.168.1.10\nPORT=3000\n')).toBe(
      'http://192.168.1.10:3000/api/health',
    );
    expect(healthUrlOf('HOST=::1\n')).toBe('http://[::1]:3000/api/health');
  });

  it('every address: asked on 127.0.0.1; the last setting wins, as systemd reads them', () => {
    expect(healthUrlOf('HOST=0.0.0.0\n')).toBe('http://127.0.0.1:3000/api/health');
    expect(healthUrlOf('HOST=::\n')).toBe('http://127.0.0.1:3000/api/health');
    expect(healthUrlOf('PORT=3000\nPORT=4000\n')).toBe('http://127.0.0.1:4000/api/health');
  });

  it('as systemd reads them: spaces and one pair of quotes taken off, CRLF lines', () => {
    expect(healthUrlOf('HOST="0.0.0.0"\nPORT=\'8080\'\n')).toBe('http://127.0.0.1:8080/api/health');
    expect(healthUrlOf('  PORT=8080 \r\nHOST=::1\r\n')).toBe('http://[::1]:8080/api/health');
  });

  it('the installer reads them the same way (app_url in files.sh)', () => {
    const files = join(HERE, '../install/lib/files.sh');
    for (const settings of [
      '',
      'PORT=8080\n',
      'HOST=192.168.1.10\nPORT=3000\n',
      'HOST=::1\n',
      'HOST=0.0.0.0\n',
      'HOST=::\n',
      'PORT=3000\nPORT=4000\n',
      'HOST="0.0.0.0"\nPORT=\'8080\'\n',
      '  PORT=8080 \r\nHOST=::1\r\n',
      'DATABASE_URL=postgresql://laris:pw@127.0.0.1:5432/laris\nHOST=127.0.0.1\n',
    ]) {
      writeFileSync(join(dir, 'app.env'), settings);
      const url = execFileSync('bash', ['-c', 'source "$1"; ETC="$2"; app_url', '_', files, dir], {
        encoding: 'utf8',
      });
      expect(`${url}/api/health`, JSON.stringify(settings)).toBe(healthUrlOf(settings));
    }
  });

  it('refuses anything that isn’t an address or a port', () => {
    for (const settings of [
      'HOST=evil.example\n',
      'HOST=127.0.0.1/x\n',
      'PORT=0\n',
      'PORT=70000\n',
      'PORT=80x\n',
    ]) {
      expect(() => healthUrlOf(settings), settings).toThrow(/HOST or PORT/);
    }
  });
});
