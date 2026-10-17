// Tests for the process wrapper (homelab-process.mts) — run in development mode (not root):
// against a pretend /proc for the refusals, and the real /proc for ending a real process (a
// child of this test). Run by the server's unit tests.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = fileURLToPath(new URL('./homelab-process.mts', import.meta.url));
const ME = process.getuid!();
const PF_KTHREAD = 0x0020_0000;

let dir: string;
let proc: string;

interface Run {
  code: number | null;
  out: string;
  result: Record<string, unknown> | null;
}

function wrapper(args: string[], input: unknown = ''): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRAPPER, ...args], {
      env: { HOMELAB_WRAPPER_CONFIG: join(dir, 'wrappers.json') },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    child.on('close', (code) => {
      const line = out.split('\n').findLast((l) => l.startsWith('@@result '));
      resolve({
        code,
        out,
        result: line ? (JSON.parse(line.slice(9)) as Record<string, unknown>) : null,
      });
    });
  });
}

function writeConfig(process: Record<string, unknown>) {
  writeFileSync(join(dir, 'wrappers.json'), JSON.stringify({ process }));
}

/** A process in the pretend /proc. */
function addProcess(
  pid: number,
  {
    uid = 1500,
    start = '5000',
    flags = 0x400000,
    cgroup = '0::/user.slice/user-1500.slice/session-3.scope',
    name = 'python3',
  } = {},
) {
  const folder = join(proc, String(pid));
  mkdirSync(folder, { recursive: true });
  // Fields 3… : state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime
  // cutime cstime priority nice threads itrealvalue starttime …
  writeFileSync(
    join(folder, 'stat'),
    `${pid} (${name}) S 1 ${pid} ${pid} 0 -1 ${flags} 0 0 0 0 10 5 0 0 20 0 1 0 ${start} 1000 100\n`,
  );
  writeFileSync(
    join(folder, 'status'),
    `Name:\t${name}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
  );
  writeFileSync(join(folder, 'cgroup'), `${cgroup}\n`);
}

const signal = (pid: number, startTicks = '5000', sig = 'TERM') =>
  wrapper(['signal'], { pid, startTicks, signal: sig });

function expectRefused(run: Run, code: string) {
  expect(run.out).toContain(`@@error code=${code}`);
  expect(run.code).not.toBe(0);
  expect(run.result).toBeNull();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'process-wrapper-'));
  proc = join(dir, 'proc');
  mkdirSync(proc);
  writeConfig({ appUid: 990, dev: { procRoot: proc } });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('homelab-process: what it refuses', () => {
  it('takes exactly one action', async () => {
    expectRefused(await wrapper([]), 'invalid_request');
    expectRefused(await wrapper(['kill']), 'invalid_request');
    expectRefused(await wrapper(['signal', 'extra']), 'invalid_request');
  });

  it.each([
    ['not JSON', 'pid=4'],
    ['an unknown key', { pid: 4312, startTicks: '5000', signal: 'TERM', uid: 0 }],
    ['a missing key', { pid: 4312, signal: 'TERM' }],
    ['a PID that is no number', { pid: '4312', startTicks: '5000', signal: 'TERM' }],
    ['PID 0', { pid: 0, startTicks: '5000', signal: 'TERM' }],
    ['a negative PID (a process group)', { pid: -1, startTicks: '5000', signal: 'TERM' }],
    ['a PID beyond Linux’s', { pid: 5_000_000, startTicks: '5000', signal: 'TERM' }],
    ['a fractional PID', { pid: 43.5, startTicks: '5000', signal: 'TERM' }],
    ['a start time that is no number', { pid: 4312, startTicks: '50a0', signal: 'TERM' }],
    ['another signal', { pid: 4312, startTicks: '5000', signal: 'HUP' }],
    ['a signal number', { pid: 4312, startTicks: '5000', signal: 9 }],
  ])('refuses %s', async (_, input) => {
    addProcess(4312);
    expectRefused(await wrapper(['signal'], input), 'invalid_request');
  });

  it('refuses PID 1, whoever owns it', async () => {
    addProcess(1, { uid: 1500 });
    expectRefused(await signal(1), 'process_protected');
  });

  it('refuses a process that isn’t there, or whose PID now names another process', async () => {
    expectRefused(await signal(4312), 'process_not_found');
    addProcess(4312, { start: '9999' });
    expectRefused(await signal(4312, '5000'), 'process_not_found');
  });

  it.each([
    ['root’s', { uid: 0 }],
    ['a system account’s', { uid: 109 }],
    ['nobody’s (above the people’s range)', { uid: 65534 }],
    ['the app’s own', { uid: 990 }],
    ['a kernel thread', { flags: PF_KTHREAD }],
    [
      'a Docker container’s (cgroup v2)',
      { cgroup: '0::/system.slice/docker-' + 'a'.repeat(64) + '.scope' },
    ],
    ['a Docker container’s (cgroup v1)', { cgroup: '12:pids:/docker/' + 'b'.repeat(64) }],
    ['a Podman container’s', { cgroup: '0::/machine.slice/libpod-' + 'c'.repeat(64) + '.scope' }],
    [
      'a rootless Docker container’s',
      {
        cgroup:
          '0::/user.slice/user-1500.slice/user@1500.service/app.slice/docker-' +
          'd'.repeat(64) +
          '.scope',
      },
    ],
    ['a systemd-nspawn machine’s', { cgroup: '0::/machine.slice/machine-web.scope/payload' }],
    ['a Kubernetes pod’s', { cgroup: '0::/kubepods/besteffort/pod1/abc' }],
  ])('refuses %s process', async (_, change) => {
    addProcess(4312, change);
    expectRefused(await signal(4312), 'process_protected');
  });

  it('refuses a person’s process run with root’s rights (setuid: one of its uids is 0)', async () => {
    addProcess(4312);
    const status = join(proc, '4312', 'status');
    writeFileSync(status, readFileSync(status, 'utf8').replace(/^Uid:.*$/m, 'Uid:\t1500\t0\t0\t0'));
    expectRefused(await signal(4312), 'process_protected');
  });

  it('lets through a person’s own rootless Docker daemon (its service is no container)', async () => {
    // Past every check, the signal goes to the real PID: one that no process has here.
    let pid = 4_000_000;
    while (existsSync(`/proc/${pid}`)) pid--;
    addProcess(pid, {
      cgroup: '0::/user.slice/user-1500.slice/user@1500.service/app.slice/docker.service',
    });
    expectRefused(await signal(pid), 'process_not_found');
  });

  it('refuses the app’s own user also from a higher configured range', async () => {
    writeConfig({ appUid: 1500, dev: { procRoot: proc } });
    addProcess(4312, { uid: 1500 });
    expectRefused(await signal(4312), 'process_protected');
  });

  it('refuses to run with an invalid configuration', async () => {
    writeConfig({ appUid: -1, dev: { procRoot: proc } });
    expectRefused(await signal(4312), 'setup');
    writeConfig({ appUid: 990, dev: { procRoot: 'relative/proc' } });
    expectRefused(await signal(4312), 'setup');
    writeConfig({ appUid: 990 });
    expectRefused(await signal(4312), 'setup');
  });
});

describe('homelab-process: ending a real process', () => {
  let child: ChildProcess;

  /** The real start time of a process (field 22 of /proc/<pid>/stat). */
  const startTicks = (pid: number) => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/)[19];
  };

  beforeEach(() => {
    child = spawn('sleep', ['60'], { stdio: 'ignore' });
    // This test's user counts as a person here; the app's user is someone else.
    writeConfig({ appUid: 0, minUid: Math.min(ME, 60000), dev: { procRoot: '/proc' } });
  });

  afterEach(() => {
    child.kill('SIGKILL');
  });

  const ended = () =>
    new Promise<NodeJS.Signals | null>((resolve) => child.on('exit', (_, sig) => resolve(sig)));

  it('sends SIGTERM to the process the app saw', async () => {
    const exit = ended();
    const run = await signal(child.pid!, startTicks(child.pid!), 'TERM');
    expect(run.result).toEqual({ signalled: true });
    expect(run.code).toBe(0);
    expect(await exit).toBe('SIGTERM');
  });

  it('sends SIGKILL ("Force end")', async () => {
    const exit = ended();
    const run = await signal(child.pid!, startTicks(child.pid!), 'KILL');
    expect(run.result).toEqual({ signalled: true });
    expect(await exit).toBe('SIGKILL');
  });

  it('leaves it alone when the start time doesn’t match', async () => {
    const wrong = String(Number(startTicks(child.pid!)) + 1);
    expectRefused(await signal(child.pid!, wrong), 'process_not_found');
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });
});
