// Tests for the helper (laris-helper.mts): the real program over pipes, with a fake `sudo` and
// `kill` (testing/fake-sudo.cjs, fake-kill.cjs) in a bin folder of its own. Run by the server's
// unit tests.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  for (const name of ['systemd-run', 'systemctl', 'docker', 'du', 'rm', 'laris-backup.mts']) {
    fake(name, 'fake-program.cjs');
  }
  start();
  expect(await nextLine()).toEqual({ 'laris-helper': 1 });
});

afterEach(() => {
  helper.kill();
  rmSync(dir, { recursive: true, force: true });
});

const KILL = () => join(dir, 'bin', 'kill');

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

  it('unlocks sudo with the password on stdin, never in the arguments', async () => {
    expect(await ask({ action: 'sudo.unlock', password: 'wrong' })).toEqual({
      ok: false,
      error: 'wrong_password',
    });
    expect(await ask({ action: 'sudo.unlock', password: 'right' })).toEqual({ ok: true });
    expect(calls('sudo')).toEqual([
      { args: ['-S', '-v'], input: 'wrong\n' },
      { args: ['-S', '-v'], input: 'right\n' },
    ]);
  });

  it('ends another’s process through the unlocked sudo, never asking', async () => {
    expect(
      await ask({ action: 'process.signal', pid: 1234, signal: 'TERM', administrator: true }),
    ).toEqual({ ok: false, error: 'sudo_required' });
    await ask({ action: 'sudo.unlock', password: 'right' });
    expect(
      await ask({ action: 'process.signal', pid: 1234, signal: 'KILL', administrator: true }),
    ).toEqual({ ok: true });
    expect(calls('sudo').at(-1)?.args).toEqual(['-n', '--', KILL(), '-s', 'KILL', '--', '1234']);
    expect(calls('kill').map((call) => call.args)).toEqual([['-s', 'KILL', '--', '1234']]);
  });

  it('locks sudo again', async () => {
    await ask({ action: 'sudo.unlock', password: 'right' });
    expect(await ask({ action: 'sudo.lock' })).toEqual({ ok: true });
    expect(calls('sudo').at(-1)?.args).toEqual(['-k']);
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
    expect(
      await ask({ action: 'process.signal', pid: 1234, signal: 'TERM', administrator: true }),
    ).toEqual({ ok: false, error: 'sudo_required' });
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
    ).toEqual({ ok: false, error: 'sudo_not_allowed' });
  });

  it('says when there is no sudo', async () => {
    rmSync(join(dir, 'bin', 'sudo'));
    expect(await ask({ action: 'sudo.unlock', password: 'right' })).toEqual({
      ok: false,
      error: 'sudo_unavailable',
    });
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
    expect(await ask({ action: 'docker.access' })).toMatchObject({
      ok: true,
      userUnits: true,
      unitDocker: true,
    });
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

  it('without the docker group: a system unit through sudo -n — locked, it says so', async () => {
    const app = join(dir, 'apps', 'music');
    mkdirSync(app, { recursive: true });
    const request = { action: 'app.task', folder: app, project: 'music', task: 'up', system: true };
    expect(await ask(request)).toEqual({ ok: false, error: 'sudo_required' });
    await ask({ action: 'sudo.unlock', password: 'right' });
    expect(await ask(request)).toMatchObject({ ok: true, system: true });
    const viaSudo = calls('sudo').at(-1)!.args;
    expect(viaSudo.slice(0, 3)).toEqual(['-n', '--', join(dir, 'bin', 'systemd-run')]);
    expect(viaSudo).not.toContain('--user');
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

  it('checks a Compose file in its folder, saying what Compose said', async () => {
    const app = join(dir, 'apps', 'music');
    mkdirSync(app, { recursive: true });
    expect(
      await ask({ action: 'compose.check', folder: app, project: 'music', docker: 'direct' }),
    ).toEqual({ ok: true });
    expect(calls('docker')[0]).toMatchObject({
      args: ['compose', '--project-name', 'music', 'config', '--quiet'],
      cwd: app,
    });
    writeFileSync(join(dir, 'docker-exit.txt'), '15');
    writeFileSync(
      join(dir, 'docker-err.txt'),
      'services.x additional property bad is not allowed\n',
    );
    expect(
      await ask({ action: 'compose.check', folder: app, project: 'music', docker: 'direct' }),
    ).toEqual({
      ok: false,
      error: 'compose_invalid',
      message: 'services.x additional property bad is not allowed',
    });
  });

  it('measures and deletes folders — never the system’s or a home itself', async () => {
    writeFileSync(join(dir, 'du-out.txt'), '4096\t/x\n');
    expect(await ask({ action: 'paths.size', paths: ['/srv/x'] })).toEqual({
      ok: true,
      sizes: { '/srv/x': { bytes: 4096, partial: false } },
    });
    for (const path of [
      '/',
      '/etc',
      '/home',
      '/home/anna',
      '/var/lib/docker/x',
      '/opt/laris',
      '/usr/lib',
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

  it('runs a root program through sudo -n, its input on stdin — only its known actions', async () => {
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
    for (const bad of [
      { ...request, command: 'run-scheduled' },
      { ...request, program: 'compose' },
      { ...request, input: 42 },
      { ...request, timeoutMs: 99 * 60 * 60_000 },
    ]) {
      expect(await ask(bad)).toEqual({ ok: false, error: 'bad_request' });
    }
  });

  it('refuses to start when a module could be changed by others', async () => {
    helper.kill();
    const copy = join(dir, 'copy');
    mkdirSync(copy);
    cpSync(join(HERE, 'laris-helper.mts'), join(copy, 'laris-helper.mts'));
    cpSync(join(HERE, 'helper'), join(copy, 'helper'), { recursive: true });
    chmodSync(join(copy, 'helper', 'actions.mts'), 0o666);
    start(join(copy, 'laris-helper.mts'));
    expect(await nextLine()).toEqual({
      'laris-helper': 1,
      error: 'setup',
      path: join(copy, 'helper', 'actions.mts'),
    });
  });
});
