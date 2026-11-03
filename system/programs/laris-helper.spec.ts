// Tests for the helper (laris-helper.mts) and laris-root behind it: the real programs over pipes,
// with a fake `sudo` and `kill` (testing/fake-sudo.cjs, fake-kill.cjs) in a bin folder of its own
// — the fake sudo starts the real laris-root, not as root. Run by the server's unit tests.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

let dir: string;
let helper: ChildProcessWithoutNullStreams;
let lines: string[];
let waiting: ((line: string) => void) | null;

function fake(name: string, source: string) {
  const path = join(dir, 'bin', name);
  writeFileSync(
    path,
    `#!/usr/bin/env node\n${readFileSync(join(HERE, 'testing', source), 'utf8')}`,
  );
  chmodSync(path, 0o755);
}

function start(entry = join(HERE, 'laris-helper.mts'), env: Record<string, string> = {}) {
  lines = [];
  waiting = null;
  helper = spawn(process.execPath, [entry], {
    env: { PATH: process.env['PATH'] ?? '', LARIS_HELPER_FAKE_BIN: join(dir, 'bin'), ...env },
  });
  let buffer = '';
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (waiting) {
        const next = waiting;
        waiting = null;
        next(line);
      } else {
        lines.push(line);
      }
    }
  });
}

function nextLine(): Promise<Record<string, unknown>> {
  const line = lines.shift();
  if (line !== undefined) return Promise.resolve(JSON.parse(line));
  return new Promise((resolve) => (waiting = (l) => resolve(JSON.parse(l))));
}

let nextId = 0;
async function ask(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = ++nextId;
  helper.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
  const answer = await nextLine();
  expect(answer['id']).toBe(id);
  const { id: _, ...rest } = answer;
  return rest;
}

const calls = (name: string) =>
  existsSync(join(dir, `${name}-calls.jsonl`))
    ? readFileSync(join(dir, `${name}-calls.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { args: string[]; input?: string; env?: object })
    : [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'laris-helper-'));
  mkdirSync(join(dir, 'bin'));
  fake('sudo', 'fake-sudo.cjs');
  fake('kill', 'fake-kill.cjs');
  for (const name of [
    'systemd-run',
    'systemctl',
    'journalctl',
    'docker',
    'du',
    'rm',
    'id',
    'laris-backup.mts',
  ]) {
    fake(name, 'fake-program.cjs');
  }
  symlinkSync(join(HERE, 'laris-root.mts'), join(dir, 'bin', 'laris-root.mts'));
  start();
  expect(await nextLine()).toEqual({ 'laris-helper': 1 });
});

afterEach(() => {
  helper.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe('laris-helper', () => {
  it('says who it runs as', async () => {
    const me = userInfo();
    expect(await ask({ action: 'hello' })).toEqual({
      ok: true,
      uid: me.uid,
      gid: me.gid,
      user: me.username,
      home: me.homedir,
    });
  });

  it('unlocks by starting laris-root through sudo, the password the one line sudo reads', async () => {
    expect(await ask({ action: 'sudo.unlock', password: 'wrong' })).toEqual({
      ok: false,
      error: 'wrong_password',
    });
    expect(await ask({ action: 'sudo.unlock', password: 'right' })).toEqual({ ok: true });
    // Never a second try: after "try again", sudo's stdin closed.
    expect(calls('sudo')).toEqual([
      { args: ['-k', '-S', '-p', '', '--', join(dir, 'bin', 'laris-root.mts')], input: 'wrong\n' },
      { args: ['-k', '-S', '-p', '', '--', join(dir, 'bin', 'laris-root.mts')], input: 'right\n' },
    ]);
    // Unlocked again: the same laris-root.
    expect(await ask({ action: 'sudo.unlock', password: 'right' })).toEqual({ ok: true });
    expect(calls('sudo')).toHaveLength(2);
  });

  it('ends another’s process through laris-root — locked, it says so', async () => {
    expect(
      await ask({ action: 'process.signal', pid: 1234, signal: 'TERM', administrator: true }),
    ).toEqual({ ok: false, error: 'sudo_required' });
    expect(calls('kill')).toEqual([]);
    await ask({ action: 'sudo.unlock', password: 'right' });
    expect(
      await ask({ action: 'process.signal', pid: 1234, signal: 'KILL', administrator: true }),
    ).toEqual({ ok: true });
    expect(calls('kill').map((call) => call.args)).toEqual([['-s', 'KILL', '--', '1234']]);
  });

  /** The helper's stdin closes (the session ended, or "Lock now"); resolves once it exited. */
  async function endHelper() {
    const exited = new Promise((resolve) => helper.on('exit', resolve));
    helper.stdin.end();
    await exited;
  }

  it('laris-root ends with its helper (the session’s end, or “Lock now”)', async () => {
    await ask({ action: 'sudo.unlock', password: 'right' });
    expect(existsSync(join(dir, 'ended'))).toBe(false);
    await endHelper();
    await vi.waitFor(() => expect(existsSync(join(dir, 'ended'))).toBe(true));
  });

  it('a new helper never unlocks with a wrong password — though sudo’s cache would let it', async () => {
    await ask({ action: 'sudo.unlock', password: 'right' });
    await endHelper();
    start();
    await nextLine();
    // As if the cache were shared (a real sudo keeps it for this account a while).
    writeFileSync(join(dir, 'cached'), '');
    expect(await ask({ action: 'sudo.unlock', password: 'wrong' })).toEqual({
      ok: false,
      error: 'wrong_password',
    });
    expect(
      await ask({ action: 'process.signal', pid: 1234, signal: 'TERM', administrator: true }),
    ).toEqual({ ok: false, error: 'sudo_required' });
  });

  it('says when laris-root ended on its own (idle), and is locked from then on', async () => {
    helper.kill();
    start(undefined, { LARIS_ROOT_IDLE_MS: '300' });
    await nextLine();
    await ask({ action: 'sudo.unlock', password: 'right' });
    expect(await nextLine()).toEqual({ event: 'sudo.locked' });
    expect(
      await ask({ action: 'process.signal', pid: 1234, signal: 'TERM', administrator: true }),
    ).toEqual({ ok: false, error: 'sudo_required' });
  });

  it('understands sudo-rs', async () => {
    writeFileSync(join(dir, 'rs.txt'), '');
    expect(await ask({ action: 'sudo.unlock', password: 'wrong' })).toEqual({
      ok: false,
      error: 'wrong_password',
    });
    writeFileSync(join(dir, 'not-allowed.txt'), '');
    expect(await ask({ action: 'sudo.unlock', password: 'right' })).toEqual({
      ok: false,
      error: 'sudo_not_allowed',
    });
  });

  it('tells an account sudo refuses apart from a wrong password', async () => {
    writeFileSync(join(dir, 'not-allowed.txt'), '');
    expect(await ask({ action: 'sudo.unlock', password: 'right' })).toEqual({
      ok: false,
      error: 'sudo_not_allowed',
    });
    expect(
      await ask({ action: 'process.signal', pid: 1234, signal: 'TERM', administrator: true }),
    ).toEqual({ ok: false, error: 'sudo_required' });
  });

  it('says when there is no sudo', async () => {
    rmSync(join(dir, 'bin', 'sudo'));
    expect(await ask({ action: 'sudo.unlock', password: 'right' })).toEqual({
      ok: false,
      error: 'sudo_unavailable',
    });
  });

  it('says when laris-root refused to start (its modules unsafe)', async () => {
    const copy = join(dir, 'copy');
    mkdirSync(copy);
    cpSync(join(HERE, 'laris-root.mts'), join(copy, 'laris-root.mts'));
    cpSync(join(HERE, 'root'), join(copy, 'root'), { recursive: true });
    cpSync(join(HERE, 'helper'), join(copy, 'helper'), { recursive: true });
    cpSync(join(HERE, 'lib'), join(copy, 'lib'), { recursive: true });
    chmodSync(join(copy, 'root', 'main.mts'), 0o666);
    rmSync(join(dir, 'bin', 'laris-root.mts'));
    symlinkSync(join(copy, 'laris-root.mts'), join(dir, 'bin', 'laris-root.mts'));
    expect(await ask({ action: 'sudo.unlock', password: 'right' })).toEqual({
      ok: false,
      error: 'failed',
    });
    expect(
      await ask({ action: 'process.signal', pid: 1234, signal: 'TERM', administrator: true }),
    ).toEqual({ ok: false, error: 'sudo_required' });
  });

  it('ends its own processes as itself, saying why one could not be ended', async () => {
    const signal = (pid: number) =>
      ask({ action: 'process.signal', pid, signal: 'TERM', administrator: false });
    expect(await signal(1234)).toEqual({ ok: true });
    expect(await signal(404)).toEqual({ ok: false, error: 'not_found' });
    expect(await signal(403)).toEqual({ ok: false, error: 'not_permitted' });
    expect(await signal(500)).toEqual({ ok: false, error: 'failed' });
    expect(calls('kill')[0]?.args).toEqual(['-s', 'TERM', '--', '1234']);
    expect(calls('sudo')).toEqual([]);
  });

  it('gives programs an environment of its own, nothing of the session’s', async () => {
    helper.kill();
    start(undefined, { SECRET: 'from the session' });
    await nextLine();
    await ask({ action: 'process.signal', pid: 1234, signal: 'TERM', administrator: false });
    const env = calls('kill')[0]?.env as Record<string, string>;
    expect(env['SECRET']).toBeUndefined();
    expect(env['LARIS_HELPER_FAKE_BIN']).toBeUndefined();
    expect(env['LC_ALL']).toBe('C');
    expect(env['HOME']).toBe(userInfo().homedir);
  });

  it('refuses anything else, and keeps going', async () => {
    const refused = { ok: false, error: 'bad_request' };
    for (const request of [
      { action: 'shell', command: 'id' },
      { action: 'process.signal', pid: 1, signal: 'TERM', administrator: false },
      { action: 'process.signal', pid: '1234', signal: 'TERM', administrator: false },
      { action: 'process.signal', pid: 1234.5, signal: 'TERM', administrator: false },
      { action: 'process.signal', pid: 4_194_305, signal: 'TERM', administrator: false },
      { action: 'process.signal', pid: 1234, signal: 'HUP', administrator: false },
      { action: 'process.signal', pid: 1234, signal: 'TERM', administrator: 'yes' },
      { action: 'sudo.unlock', password: 'right\nmore' },
      { action: 'sudo.unlock', password: '' },
      { action: 'sudo.unlock', password: 'x'.repeat(1025) },
      { action: 'sudo.unlock' },
    ]) {
      expect(await ask(request)).toEqual(refused);
    }
    for (const line of ['not json', '[1]', '{"action":"hello"}', '{"id":"1","action":"hello"}']) {
      helper.stdin.write(`${line}\n`);
      expect(await nextLine()).toEqual({ id: null, ...refused });
    }
    helper.stdin.write(`${'x'.repeat(70 * 1024)}\n`);
    expect(await nextLine()).toEqual({ id: null, ...refused });
    expect(await ask({ action: 'hello' })).toMatchObject({ ok: true });
    expect(calls('sudo')).toEqual([]);
    expect(calls('kill')).toEqual([]);
  });

  it('tells whether Docker works without sudo: in a user unit, and in this session', async () => {
    writeFileSync(join(dir, 'systemd-run-out.txt'), 'anna sudo docker\n');
    writeFileSync(join(dir, 'id-out.txt'), 'anna sudo\n');
    expect(await ask({ action: 'docker.access' })).toEqual({
      ok: true,
      userUnits: true,
      unitDocker: true,
      loginDocker: false,
    });
    expect(calls('id')[0]?.args).toEqual(['-nG']);
    writeFileSync(join(dir, 'id-out.txt'), 'anna docker\n');
    expect(calls('systemd-run')[0]?.args).toEqual([
      '--user',
      '--wait',
      '--pipe',
      '--quiet',
      '--collect',
      '--',
      join(dir, 'bin', 'id'),
      '-nG',
    ]);
    writeFileSync(join(dir, 'systemd-run-exit.txt'), '1');
    expect(await ask({ action: 'docker.access' })).toMatchObject({
      userUnits: false,
      unitDocker: false,
      loginDocker: true,
    });
  });

  it('starts an app’s task as a unit: its log in the app’s folder, its result added at the end', async () => {
    const app = join(dir, 'apps', 'music');
    mkdirSync(app, { recursive: true });
    const started = await ask({
      action: 'app.task',
      folder: app,
      project: 'music',
      task: 'update',
      system: false,
    });
    expect(started).toMatchObject({ ok: true, system: false, action: 'update' });
    const unit = started['unit'] as string;
    expect(unit).toMatch(/^laris-app-music-update-\d{8}T\d{6}$/);
    const log = join(app, '.laris', 'tasks', started['log'] as string);
    expect(existsSync(log)).toBe(true);
    expect(JSON.parse(readFileSync(join(app, '.laris', 'task.json'), 'utf8'))).toMatchObject({
      unit,
      system: false,
    });
    expect(calls('systemd-run')[0]?.args).toEqual([
      '--user',
      `--unit=${unit}`,
      '--collect',
      '--quiet',
      `--working-directory=${app}`,
      `--property=StandardOutput=append:${log}`,
      `--property=StandardError=append:${log}`,
      '--property=ExecStopPost=/usr/bin/echo @@laris-result',
      '--property=ExecStopPost=/usr/bin/printenv SERVICE_RESULT EXIT_CODE EXIT_STATUS',
      '--',
      join(dir, 'bin', 'docker'),
      'compose',
      '--project-name',
      'music',
      'up',
      '--detach',
      '--pull',
      'always',
      '--remove-orphans',
    ]);
  });

  it('without the docker group: a system unit by laris-root — locked, it says so', async () => {
    const app = join(dir, 'apps', 'music');
    mkdirSync(app, { recursive: true });
    const request = { action: 'app.task', folder: app, project: 'music', task: 'up', system: true };
    expect(await ask(request)).toEqual({ ok: false, error: 'sudo_required' });
    // Nothing started: no log left behind.
    expect(readdirSync(join(app, '.laris', 'tasks'))).toEqual([]);
    await ask({ action: 'sudo.unlock', password: 'right' });
    const started = await ask(request);
    expect(started).toMatchObject({ ok: true, system: true });
    const args = calls('systemd-run').at(-1)!.args;
    expect(args).not.toContain('--user');
    expect(args).toContain(`--unit=${started['unit'] as string}`);
    expect(args).toContain(
      `--property=StandardOutput=append:${join(app, '.laris', 'tasks', started['log'] as string)}`,
    );
  });

  it('laris-root starts a system unit only for a log the account made, as the helper names it', async () => {
    const app = join(dir, 'apps', 'music');
    mkdirSync(join(app, '.laris', 'tasks'), { recursive: true });
    const unit = 'laris-app-music-up-20261029T120000';
    const log = join(app, '.laris', 'tasks', '20261029T120000-up.log');
    writeFileSync(log, '');
    const base = { action: 'app.task', project: 'music', folder: app, task: 'up', unit, log };
    const root = spawn(process.execPath, [join(HERE, 'laris-root.mts')], {
      env: { PATH: process.env['PATH'] ?? '', LARIS_HELPER_FAKE_BIN: join(dir, 'bin') },
    });
    const answers: string[] = [];
    root.stdout.setEncoding('utf8');
    root.stdout.on('data', (chunk: string) => answers.push(...chunk.trim().split('\n')));
    const requests = [
      base,
      { ...base, unit: 'laris-app-other-up-20261029T120000' },
      { ...base, unit: 'laris-app-music-down-20261029T120000' },
      { ...base, log: join(app, '.laris', 'tasks', '20261029T120001-up.log') },
      { ...base, log: '/etc/passwd' },
      { ...base, folder: '/nowhere' },
    ];
    requests.forEach((request, index) =>
      root.stdin.write(`${JSON.stringify({ id: index + 1, ...request })}\n`),
    );
    root.stdin.end();
    await new Promise((resolve) => root.on('close', resolve));
    const byId = Object.fromEntries(
      answers.slice(1).map((line) => {
        const { id, ...answer } = JSON.parse(line) as { id: number; ok: boolean; error?: string };
        return [id, answer];
      }),
    );
    expect(answers[0]).toBe('{"laris-root":1}');
    expect(byId[1]).toEqual({ ok: true });
    for (const id of [2, 3, 4, 5, 6])
      expect(byId[id], String(id)).toEqual({ ok: false, error: 'bad_request' });
    expect(calls('systemd-run')).toHaveLength(1);
  });

  it('asks a unit’s state without sudo; refuses a unit not of its own naming', async () => {
    writeFileSync(join(dir, 'systemctl-out.txt'), 'active\n');
    expect(
      await ask({
        action: 'app.taskState',
        unit: 'laris-app-music-up-20261028T120000',
        system: true,
      }),
    ).toEqual({ ok: true, active: 'active' });
    expect(calls('systemctl')[0]?.args).toEqual([
      'is-active',
      '--',
      'laris-app-music-up-20261028T120000.service',
    ]);
    expect(await ask({ action: 'app.taskState', unit: 'sshd', system: true })).toEqual({
      ok: false,
      error: 'bad_request',
    });
  });

  it('checks a Compose file in its folder: only its mounts and labels come back, never its values', async () => {
    const app = join(dir, 'apps', 'music');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(dir, 'docker-out.txt'),
      JSON.stringify({
        name: 'music',
        services: {
          web: {
            environment: { PASSWORD: 'hunter2' },
            labels: { 'laris.template': 'navidrome@2', other: 'x' },
            volumes: [
              { type: 'bind', source: `${app}/data`, target: '/data' },
              { type: 'volume', target: '/cache' },
              { type: 'volume', source: 'db', target: '/db' },
            ],
          },
          extra: { profiles: ['extra'], volumes: [{ type: 'volume', source: 'ext' }] },
        },
        volumes: { db: { name: 'music_db' }, ext: { name: 'shared', external: true } },
      }),
    );
    const answer = await ask({ action: 'compose.check', folder: app, project: 'music' });
    expect(answer).toEqual({
      ok: true,
      mounts: [
        { type: 'bind', source: `${app}/data` },
        { type: 'volume', source: null },
        { type: 'volume', source: 'db' },
        { type: 'volume', source: 'ext' },
      ],
      volumes: [
        { key: 'db', name: 'music_db', external: false },
        { key: 'ext', name: 'shared', external: true },
      ],
      templates: ['navidrome@2'],
    });
    expect(JSON.stringify(answer)).not.toContain('hunter2');
    expect(calls('docker')[0]).toMatchObject({
      args: ['compose', '--project-name', 'music', '--profile', '*', 'config', '--format', 'json'],
      cwd: app,
    });
    writeFileSync(join(dir, 'docker-exit.txt'), '15');
    writeFileSync(
      join(dir, 'docker-err.txt'),
      'services.x additional property bad is not allowed\n',
    );
    expect(await ask({ action: 'compose.check', folder: app, project: 'music' })).toEqual({
      ok: false,
      error: 'compose_invalid',
      message: 'services.x additional property bad is not allowed',
    });
  });

  it('refuses an answer too large for the server to read', async () => {
    const app = join(dir, 'apps', 'music');
    mkdirSync(app, { recursive: true });
    const volumes = Array.from({ length: 200 }, (_, i) => ({
      type: 'bind',
      source: `/srv/${'x'.repeat(900)}/${i}`,
    }));
    writeFileSync(join(dir, 'docker-out.txt'), JSON.stringify({ services: { web: { volumes } } }));
    expect(await ask({ action: 'compose.check', folder: app, project: 'music' })).toEqual({
      ok: false,
      error: 'too_large',
    });
  });

  it('passes on at most 4000 characters of what Compose said', async () => {
    const app = join(dir, 'apps', 'music');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(dir, 'docker-exit.txt'), '15');
    writeFileSync(join(dir, 'docker-err.txt'), `invalid: ${'x'.repeat(300_000)}\n`);
    const answer = await ask({ action: 'compose.check', folder: app, project: 'music' });
    expect(answer).toMatchObject({ ok: false, error: 'compose_invalid' });
    expect(String(answer['message']).length).toBe(4000);
  });

  it('a volume already gone is no error; another refusal is', async () => {
    writeFileSync(join(dir, 'docker-exit.txt'), '1');
    writeFileSync(
      join(dir, 'docker-err.txt'),
      'Error response from daemon: get x_cache: no such volume\n',
    );
    expect(await ask({ action: 'volumes.remove', names: ['x_cache'], docker: 'direct' })).toEqual({
      ok: true,
    });
    writeFileSync(join(dir, 'docker-err.txt'), 'Error response from daemon: volume is in use\n');
    expect(
      await ask({ action: 'volumes.remove', names: ['x_cache'], docker: 'direct' }),
    ).toMatchObject({ ok: false, error: 'compose_failed' });
  });

  it('says Docker is missing', async () => {
    const app = join(dir, 'apps', 'music');
    mkdirSync(app, { recursive: true });
    rmSync(join(dir, 'bin', 'docker'));
    expect(await ask({ action: 'compose.check', folder: app, project: 'music' })).toEqual({
      ok: false,
      error: 'docker_unavailable',
    });
  });

  it.runIf(existsSync('/usr/bin/docker'))(
    'with the real Compose: binds, ~, anonymous, named, external and profiled volumes, a missing variable',
    async () => {
      const app = join(dir, 'apps', 'music');
      mkdirSync(app, { recursive: true });
      rmSync(join(dir, 'bin', 'docker'));
      symlinkSync('/usr/bin/docker', join(dir, 'bin', 'docker'));
      writeFileSync(
        join(app, 'compose.yml'),
        [
          'services:',
          '  web:',
          '    image: nginx:1.27',
          '    labels: { laris.template: "nginx@3" }',
          '    environment: { SECRET: "${PASS:?set PASS}" }',
          '    volumes:',
          '      - ./data:/data',
          '      - ~/music:/music',
          '      - /var/cache',
          '      - db:/db',
          '      - ext:/ext',
          '      - { type: bind, source: "${DIR:-./other}", target: /other }',
          '  extra:',
          '    image: redis:7',
          '    profiles: [extra]',
          '    volumes: [named:/n]',
          'volumes:',
          '  db:',
          '  ext: { external: true }',
          '  named: { name: custom }',
          '',
        ].join('\n'),
      );
      writeFileSync(join(app, '.env'), 'PASS=hunter2\n');
      const answer = await ask({ action: 'compose.check', folder: app, project: 'music' });
      expect(answer).toEqual({
        ok: true,
        // Compose's order: services by name.
        mounts: [
          { type: 'volume', source: 'named' },
          { type: 'bind', source: join(app, 'data') },
          { type: 'bind', source: join(userInfo().homedir, 'music') },
          { type: 'volume', source: null },
          { type: 'volume', source: 'db' },
          { type: 'volume', source: 'ext' },
          { type: 'bind', source: join(app, 'other') },
        ],
        volumes: [
          { key: 'db', name: 'music_db', external: false },
          { key: 'ext', name: 'ext', external: true },
          { key: 'named', name: 'custom', external: false },
        ],
        templates: ['nginx@3'],
      });
      expect(JSON.stringify(answer)).not.toContain('hunter2');
      writeFileSync(join(app, '.env'), '');
      expect(await ask({ action: 'compose.check', folder: app, project: 'music' })).toMatchObject({
        ok: false,
        error: 'compose_invalid',
        message: expect.stringContaining('set PASS'),
      });
    },
  );

  it('runs Docker and deletes folders as root through laris-root only', async () => {
    const app = join(dir, 'apps', 'music');
    mkdirSync(app, { recursive: true });
    const asRoot = [
      { action: 'volumes.remove', names: ['music_data'], docker: 'sudo' },
      { action: 'paths.remove', paths: ['/srv/music'], administrator: true },
    ];
    for (const request of asRoot) {
      expect(await ask(request)).toEqual({ ok: false, error: 'sudo_required' });
    }
    expect(calls('docker')).toEqual([]);
    expect(calls('rm')).toEqual([]);
    await ask({ action: 'sudo.unlock', password: 'right' });
    for (const request of asRoot) expect(await ask(request)).toEqual({ ok: true });
    expect(calls('docker').map((call) => call.args)).toEqual([
      ['volume', 'rm', '--', 'music_data'],
    ]);
    expect(calls('rm').at(-1)?.args).toEqual(['-r', '-f', '--one-file-system', '--', '/srv/music']);
    // Protected paths stay protected as root.
    expect(await ask({ action: 'paths.remove', paths: ['/etc'], administrator: true })).toEqual({
      ok: false,
      error: 'path_protected',
    });
  });

  it('measures and deletes folders — never the system’s or a home itself', async () => {
    writeFileSync(join(dir, 'du-out.txt'), '4096\t/x\n');
    expect(await ask({ action: 'paths.size', paths: ['/srv/x'] })).toEqual({
      ok: true,
      sizes: { '/srv/x': { bytes: 4096, partial: false } },
    });
    symlinkSync('/etc', join(dir, 'etc-link'));
    for (const path of [
      '/',
      '/etc',
      '/home',
      '/home/anna',
      '/var/lib/docker/x',
      '/opt/laris',
      '/usr/lib',
      // Through a symlink: where it really is counts (/var/run is /run).
      join(dir, 'etc-link', 'passwd'),
    ]) {
      expect(
        await ask({ action: 'paths.remove', paths: [path], administrator: false }),
        path,
      ).toEqual({
        ok: false,
        error: 'path_protected',
      });
    }
    expect(
      await ask({ action: 'paths.remove', paths: ['/home/anna/apps/x'], administrator: false }),
    ).toEqual({ ok: true });
    expect(calls('rm').at(-1)?.args).toEqual([
      '-r',
      '-f',
      '--one-file-system',
      '--',
      '/home/anna/apps/x',
    ]);
    expect(
      await ask({ action: 'paths.remove', paths: ['relative'], administrator: false }),
    ).toEqual({
      ok: false,
      error: 'bad_request',
    });
  });

  it('runs a root program through laris-root, its input on stdin — only its known actions', async () => {
    const request = {
      action: 'root.run',
      program: 'backup',
      command: 'start',
      input: '{"runId":"r"}',
    };
    expect(await ask(request)).toEqual({ ok: false, error: 'sudo_required' });
    await ask({ action: 'sudo.unlock', password: 'right' });
    writeFileSync(join(dir, 'laris-backup.mts-out.txt'), '@@result {"started":true}\n');
    expect(await ask(request)).toEqual({
      ok: true,
      code: 0,
      output: '@@result {"started":true}\n',
    });
    expect(calls('laris-backup.mts').at(-1)).toMatchObject({
      args: ['start'],
      input: '{"runId":"r"}',
    });
    // A long output keeps its end, from a line start: the result marker is last.
    writeFileSync(
      join(dir, 'laris-backup.mts-out.txt'),
      `${'> borg: x\n'.repeat(8000)}@@result {"started":true}\n`,
    );
    const long = (await ask(request)) as { output: string };
    expect(long.output.endsWith('@@result {"started":true}\n')).toBe(true);
    expect(long.output.startsWith('> borg: x\n')).toBe(true);
    expect(long.output.length).toBeLessThanOrEqual(48 * 1024);
    for (const bad of [
      { ...request, command: 'run-scheduled' },
      { ...request, program: 'compose' },
      { ...request, input: 42 },
      { ...request, timeoutMs: 99 * 60 * 60_000 },
    ]) {
      expect(await ask(bad)).toEqual({ ok: false, error: 'bad_request' });
    }
  });

  it('lists service units from systemd’s JSON: their file’s state, failed first, unit files never loaded too, odd entries left out', async () => {
    writeFileSync(
      join(dir, 'systemctl-list-units-out.txt'),
      JSON.stringify([
        {
          unit: 'nginx.service',
          load: 'loaded',
          active: 'active',
          sub: 'running',
          description: 'Web',
        },
        {
          unit: 'old.service',
          load: 'not-found',
          active: 'inactive',
          sub: 'dead',
          description: '',
        },
        {
          unit: 'vpn.service',
          load: 'loaded',
          active: 'failed',
          sub: 'failed',
          description: 'VPN',
        },
        { unit: '-x.service', load: 'loaded', active: 'active', sub: 'running', description: '' },
        { unit: 'dbus.socket', load: 'loaded', active: 'active', sub: 'running', description: '' },
        { unit: 'getty@tty1.service', load: 'loaded', active: 'active', sub: 'running' },
        null,
      ]),
    );
    writeFileSync(
      join(dir, 'systemctl-list-unit-files-out.txt'),
      JSON.stringify([
        { unit_file: 'nginx.service', state: 'enabled', preset: 'enabled' },
        { unit_file: 'vpn.service', state: 'disabled', preset: null },
        { unit_file: 'spare.service', state: 'disabled', preset: 'disabled' },
        { unit_file: 'getty@.service', state: 'enabled', preset: 'enabled' },
        { unit_file: 'web.service', state: 'alias', preset: null },
      ]),
    );
    expect(await ask({ action: 'units.list' })).toEqual({
      ok: true,
      truncated: false,
      units: [
        {
          unit: 'vpn.service',
          load: 'loaded',
          active: 'failed',
          sub: 'failed',
          description: 'VPN',
          enabled: 'disabled',
        },
        {
          unit: 'nginx.service',
          load: 'loaded',
          active: 'active',
          sub: 'running',
          description: 'Web',
          enabled: 'enabled',
        },
        {
          unit: 'getty@tty1.service',
          load: 'loaded',
          active: 'active',
          sub: 'running',
          description: '',
          enabled: null,
        },
        {
          unit: 'old.service',
          load: 'not-found',
          active: 'inactive',
          sub: 'dead',
          description: '',
          enabled: null,
        },
        {
          unit: 'spare.service',
          load: 'not-loaded',
          active: 'inactive',
          sub: 'dead',
          description: '',
          enabled: 'disabled',
        },
      ],
    });
    // Both asked at once: in either order.
    expect(calls('systemctl').map((call) => call.args)).toEqual(
      expect.arrayContaining([
        ['list-units', '--type=service', '--all', '--output=json', '--no-pager'],
        ['list-unit-files', '--type=service', '--output=json', '--no-pager'],
      ]),
    );
    expect(calls('sudo')).toEqual([]);
  });

  it('keeps a list within what the server reads, failed ones first; says when systemctl fails', async () => {
    const units = Array.from({ length: 3000 }, (_, i) => ({
      unit: `unit-${i}.service`,
      load: 'loaded',
      active: i === 2999 ? 'failed' : 'inactive',
      sub: 'dead',
      description: 'd'.repeat(60),
    }));
    writeFileSync(join(dir, 'systemctl-list-units-out.txt'), JSON.stringify(units));
    const answer = (await ask({ action: 'units.list' })) as {
      truncated: boolean;
      units: { unit: string }[];
    };
    expect(answer.truncated).toBe(true);
    expect(answer.units[0]?.unit).toBe('unit-2999.service');
    expect(JSON.stringify(answer).length).toBeLessThan(256 * 1024);

    writeFileSync(join(dir, 'systemctl-list-units-out.txt'), 'not json');
    expect(await ask({ action: 'units.list' })).toEqual({ ok: false, error: 'failed' });
    writeFileSync(join(dir, 'systemctl-list-units-exit.txt'), '1');
    expect(await ask({ action: 'units.list' })).toEqual({ ok: false, error: 'failed' });
  });

  it('shows one unit’s fixed properties, nothing else it says', async () => {
    writeFileSync(
      join(dir, 'systemctl-show-out.txt'),
      [
        'Id=nginx.service',
        'Names=nginx.service web.service',
        'ActiveState=active',
        'MainPID=452',
        'MemoryCurrent=[not set]',
        'StateChangeTimestamp=@1792573340',
        'Environment=SECRET=x',
        'Description=A web server = fast',
        '',
      ].join('\n'),
    );
    expect(await ask({ action: 'units.show', unit: 'nginx.service' })).toEqual({
      ok: true,
      properties: {
        Id: 'nginx.service',
        Names: 'nginx.service web.service',
        ActiveState: 'active',
        MainPID: '452',
        MemoryCurrent: '[not set]',
        StateChangeTimestamp: '@1792573340',
        Description: 'A web server = fast',
      },
    });
    const args = calls('systemctl')[0]?.args ?? [];
    expect(args.slice(0, 3)).toEqual(['show', '--timestamp=unix', '--no-pager']);
    expect(args[3]).toMatch(/^--property=Id,Names,/);
    expect(args.slice(4)).toEqual(['--', 'nginx.service']);
    for (const unit of ['nginx', '--all.service', 'a/b.service', 'x.socket', 42]) {
      expect(await ask({ action: 'units.show', unit })).toEqual({
        ok: false,
        error: 'bad_request',
      });
    }
    expect(calls('systemctl')).toHaveLength(1);
  });

  it('starts, stops and restarts a unit through laris-root only — locked, it says so', async () => {
    const request = { action: 'units.control', unit: 'nginx.service', command: 'restart' };
    expect(await ask(request)).toEqual({ ok: false, error: 'sudo_required' });
    expect(calls('systemctl')).toEqual([]);
    await ask({ action: 'sudo.unlock', password: 'right' });
    expect(await ask(request)).toEqual({ ok: true });
    expect(calls('systemctl').map((call) => call.args)).toEqual([
      ['restart', '--no-ask-password', '--', 'nginx.service'],
    ]);
    writeFileSync(join(dir, 'systemctl-restart-exit.txt'), '1');
    writeFileSync(join(dir, 'systemctl-restart-err.txt'), 'Job for nginx.service failed.\n');
    expect(await ask(request)).toEqual({
      ok: false,
      error: 'failed',
      message: 'Job for nginx.service failed.',
    });
    for (const bad of [
      { ...request, command: 'enable' },
      { ...request, command: 'kill' },
      { ...request, unit: '-H.service' },
      { ...request, unit: 'nginx' },
    ]) {
      expect(await ask(bad)).toEqual({ ok: false, error: 'bad_request' });
    }
    expect(calls('systemctl')).toHaveLength(2);
  });

  describe('the journal', () => {
    const CURSOR = (i: number) => `s=abc;i=${i.toString(16)};b=f00d;m=1;t=2;x=3`;
    const entry = (i: number, fields: Record<string, unknown> = {}) => ({
      __CURSOR: CURSOR(i),
      __REALTIME_TIMESTAMP: String(1_792_000_000_000_000 + i),
      __MONOTONIC_TIMESTAMP: '5',
      _BOOT_ID: 'f00d',
      PRIORITY: '6',
      _SYSTEMD_UNIT: 'nginx.service',
      SYSLOG_IDENTIFIER: 'nginx',
      _PID: '42',
      MESSAGE: `line ${i}`,
      ...fields,
    });
    const output = (entries: unknown[]) =>
      writeFileSync(
        join(dir, 'journalctl-out.txt'),
        entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      );
    const read = { action: 'journal.read', priority: 6, boot: 0, administrator: false };
    const group = (name: string) =>
      writeFileSync(
        join(dir, 'bin', 'group'),
        `root:x:0:\n${name}:x:${process.getgroups!()[0]}:someone\n`,
      );

    it('reads the newest lines, newest first, and gives them oldest first — only the fields it knows, messages as text', async () => {
      group('users');
      output([
        entry(3, { MESSAGE: [104, 105, 0xff], _CMDLINE: 'secret --password=x', _EXE: '/x' }),
        entry(2, { SYSLOG_IDENTIFIER: ['first', 'second'], PRIORITY: undefined }),
        { MESSAGE: 'no cursor', __REALTIME_TIMESTAMP: '1' },
        'not json',
        entry(1, { MESSAGE: 'é'.repeat(9000) }),
      ]);
      const answer = (await ask(read)) as { lines: Record<string, unknown>[] };
      expect(answer).toMatchObject({ ok: true, more: false, access: 'own' });
      expect(answer.lines.map((l) => l['cursor'])).toEqual([CURSOR(1), CURSOR(2), CURSOR(3)]);
      expect(answer.lines[2]).toEqual({
        cursor: CURSOR(3),
        time: '1792000000000003',
        priority: '6',
        unit: 'nginx.service',
        identifier: 'nginx',
        pid: '42',
        message: 'hi�',
      });
      expect(answer.lines[1]).toMatchObject({ identifier: 'first', priority: null });
      // 16 KB of a two-byte character: cut between characters, marked.
      expect(answer.lines[0]).toMatchObject({ message: 'é'.repeat(8192), truncated: true });
      expect(calls('journalctl').map((call) => call.args)).toEqual([
        [
          '--no-pager',
          '--quiet',
          '--output=json',
          '--all',
          '--output-fields=PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_PID,MESSAGE',
          '--boot=0',
          '--priority=6',
          '--lines=501',
          '--reverse',
        ],
      ]);
    });

    it('reads after a cursor oldest first, and before one back from it; each filter one argument', async () => {
      group('adm');
      output([entry(5), entry(6)]);
      expect(
        await ask({
          ...read,
          unit: 'nginx.service',
          priority: 7,
          boot: 'f9f89b85a48e4a8e9fa9736de394a41f',
          after: CURSOR(4),
        }),
      ).toMatchObject({ ok: true, more: false, access: 'all' });
      output([entry(4), entry(3), entry(2)]);
      const older = (await ask({ ...read, boot: -1, before: CURSOR(4) })) as {
        lines: { cursor: string }[];
      };
      // The cursor's own entry isn't sent again.
      expect(older.lines.map((l) => l.cursor)).toEqual([CURSOR(2), CURSOR(3)]);
      const [after, before] = calls('journalctl').map((call) => call.args.slice(5));
      expect(after).toEqual([
        '--boot=f9f89b85a48e4a8e9fa9736de394a41f',
        '--unit=nginx.service',
        '--lines=501',
        `--after-cursor=${CURSOR(4)}`,
      ]);
      expect(before).toEqual([
        '--boot=-1',
        '--priority=6',
        '--lines=502',
        `--cursor=${CURSOR(4)}`,
        '--reverse',
      ]);
    });

    it('stops at 500 lines or what the server reads, and says there’s more', async () => {
      output(Array.from({ length: 600 }, (_, i) => entry(i + 1)));
      const many = (await ask({ ...read, after: CURSOR(0) })) as {
        lines: { cursor: string }[];
        more: boolean;
      };
      expect(many.more).toBe(true);
      expect(many.lines).toHaveLength(500);
      expect(many.lines.at(-1)?.cursor).toBe(CURSOR(500));
      output(Array.from({ length: 100 }, (_, i) => entry(i + 1, { MESSAGE: 'x'.repeat(10_000) })));
      const long = (await ask({ ...read, after: CURSOR(0) })) as {
        lines: { cursor: string }[];
        more: boolean;
      };
      expect(long.more).toBe(true);
      expect(long.lines[0]?.cursor).toBe(CURSOR(1));
      expect(JSON.stringify(long).length).toBeLessThan(256 * 1024);
      expect(long.lines.length).toBeGreaterThan(15);
    });

    it('refuses what isn’t a unit, priority, boot or cursor; journalctl’s refusals say failed', async () => {
      for (const bad of [
        { ...read, unit: 'nginx' },
        { ...read, unit: '--all.service' },
        { ...read, priority: 8 },
        { ...read, priority: '6' },
        { ...read, boot: 1 },
        { ...read, boot: 'F9F89B85A48E4A8E9FA9736DE394A41F' },
        { ...read, boot: undefined },
        { ...read, after: 'a b' },
        { ...read, after: '--x=y;z' + ',' },
        { ...read, after: CURSOR(1), before: CURSOR(2) },
        { ...read, administrator: 'no' },
      ]) {
        expect(await ask(bad)).toEqual({ ok: false, error: 'bad_request' });
      }
      expect(calls('journalctl')).toEqual([]);
      writeFileSync(join(dir, 'journalctl-exit.txt'), '1');
      expect(await ask(read)).toEqual({ ok: false, error: 'failed' });
    });

    it('reads as administrator through laris-root only — locked, it says so', async () => {
      output([entry(1)]);
      const asAdministrator = { ...read, administrator: true };
      expect(await ask(asAdministrator)).toEqual({ ok: false, error: 'sudo_required' });
      expect(await ask({ action: 'journal.boots', administrator: true })).toEqual({
        ok: false,
        error: 'sudo_required',
      });
      expect(calls('journalctl')).toEqual([]);
      await ask({ action: 'sudo.unlock', password: 'right' });
      expect(await ask(asAdministrator)).toMatchObject({
        ok: true,
        lines: [{ cursor: CURSOR(1) }],
      });
      expect(calls('journalctl')).toHaveLength(1);
    });

    it('lists the boots newest first; journalctl that can’t say them as JSON: none', async () => {
      group('systemd-journal');
      writeFileSync(
        join(dir, 'journalctl-out.txt'),
        JSON.stringify([
          {
            index: -1,
            boot_id: 'a'.repeat(32),
            first_entry: 1_700_000_000_000_000,
            last_entry: 1_700_000_100_000_000,
          },
          {
            index: 0,
            boot_id: 'b'.repeat(32),
            first_entry: 1_700_000_200_000_000,
            last_entry: 1_700_000_300_000_000,
          },
          { index: 1, boot_id: '../x', first_entry: 1, last_entry: 2 },
          null,
        ]),
      );
      const request = { action: 'journal.boots', administrator: false };
      expect(await ask(request)).toEqual({
        ok: true,
        access: 'all',
        boots: [
          {
            id: 'b'.repeat(32),
            offset: 0,
            first: 1_700_000_200_000_000,
            last: 1_700_000_300_000_000,
          },
          {
            id: 'a'.repeat(32),
            offset: -1,
            first: 1_700_000_000_000_000,
            last: 1_700_000_100_000_000,
          },
        ],
      });
      expect(calls('journalctl')[0]?.args).toEqual([
        '--no-pager',
        '--quiet',
        '--output=json',
        '--list-boots',
      ]);
      writeFileSync(join(dir, 'journalctl-out.txt'), ' -1 aaaa Mon 2026-11-02 — Mon 2026-11-02\n');
      expect(await ask(request)).toEqual({ ok: true, access: 'all', boots: null });
      writeFileSync(join(dir, 'journalctl-exit.txt'), '1');
      expect(await ask(request)).toEqual({ ok: false, error: 'failed' });
      expect(await ask({ action: 'journal.boots' })).toEqual({ ok: false, error: 'bad_request' });
    });
  });

  it.each([
    ['helper', 'actions.mts'],
    ['lib', 'lines.mts'],
  ])('refuses to start when a module could be changed by others (%s/%s)', async (folder, file) => {
    helper.kill();
    const copy = join(dir, `copy-${folder}`);
    mkdirSync(copy);
    cpSync(join(HERE, 'laris-helper.mts'), join(copy, 'laris-helper.mts'));
    cpSync(join(HERE, 'helper'), join(copy, 'helper'), { recursive: true });
    cpSync(join(HERE, 'lib'), join(copy, 'lib'), { recursive: true });
    chmodSync(join(copy, folder, file), 0o666);
    start(join(copy, 'laris-helper.mts'));
    expect(await nextLine()).toEqual({
      'laris-helper': 1,
      error: 'setup',
      path: join(copy, folder, file),
    });
  });
});
