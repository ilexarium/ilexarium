import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT_LOCK } from './lib/lock.mts';

const CHECKS = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/checks.sh');
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/packages.sh');
const COMMON = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/common.sh');
const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/platform.sh');

// The installer's own functions, fed samples: `source` only defines them.
const call = (fn: string, ...args: string[]) =>
  execFileSync(
    'bash',
    ['-c', 'source "$1"; source "$2"; "${@:3}"', '_', CHECKS, PACKAGES, fn, ...args],
    { encoding: 'utf8' },
  );
const holds = (fn: string, ...args: string[]) =>
  spawnSync('bash', [
    '-c',
    'source "$1"; source "$2"; "${@:3}"',
    '_',
    CHECKS,
    PACKAGES,
    fn,
    ...args,
  ]).status === 0;

describe('the installer’s machine checks', () => {
  it('knows Debian, Ubuntu (apt) and Arch (pacman) from os-release, nothing else', () => {
    expect(call('os_family', 'debian', '12', '')).toBe('apt');
    expect(call('os_family', 'debian', '13', '')).toBe('apt');
    expect(call('os_family', 'ubuntu', '24.04', 'debian')).toBe('apt');
    expect(call('os_family', 'arch', '', '')).toBe('pacman');
    expect(call('os_family', 'archarm', '', 'arch')).toBe('pacman');
    expect(call('os_family', 'endeavouros', '', 'arch')).toBe('pacman');
    expect(call('os_family', 'debian', '11', '')).toBe('');
    expect(call('os_family', 'ubuntu', '22.04', 'debian')).toBe('');
    expect(call('os_family', 'fedora', '41', '')).toBe('');
    expect(call('os_family', 'manjaro-arm', '', 'archlinux')).toBe('');
  });

  it('the CPU as Debian names it, only amd64 and arm64', () => {
    expect(call('cpu_arch', 'x86_64')).toBe('amd64');
    expect(call('cpu_arch', 'aarch64')).toBe('arm64');
    expect(call('cpu_arch', 'armv7l')).toBe('');
    expect(call('cpu_arch', 'riscv64')).toBe('');
  });

  it('compares versions', () => {
    expect(holds('version_ge', '24.5.0', '24.5.0')).toBe(true);
    expect(holds('version_ge', '24.10.0', '24.5.0')).toBe(true);
    expect(holds('version_ge', '25.1.0', '24.5.0')).toBe(true);
    expect(holds('version_ge', '24.4.1', '24.5.0')).toBe(false);
    expect(holds('version_ge', '0.10.0', '0.9.0')).toBe(true);
    expect(holds('version_ge', '0.9.0', '0.10.0')).toBe(false);
    expect(holds('version_ge', '1.4.0', '1.4')).toBe(true);
    expect(holds('version_ge', '1.2.8', '1.4')).toBe(false);
  });

  it('Borg 1.4 or a later 1.x, never 2', () => {
    for (const version of ['1.4', '1.4.0', '1.4.1', '1.5.0'])
      expect(holds('borg_fits', version), version).toBe(true);
    for (const version of ['', '1.2.8', '1.3.0', '2.0.0', '2.0.0b14', '2.1.0'])
      expect(holds('borg_fits', version), version).toBe(false);
  });
});

// A script over the installer's own files: $1 common.sh, $2 checks.sh, $3 platform.sh.
const script = (body: string, env: Record<string, string> = {}) =>
  spawnSync(
    'bash',
    ['-c', `source "$1"; source "$2"; source "$3"; ${body}`, '_', COMMON, CHECKS, PLATFORM],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );

describe('the installer’s lock (the root programs’ own)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'laris-install-lock-'));
  const lock = join(dir, 'run', 'compose.lock');
  const sleepers: ReturnType<typeof spawn>[] = [];
  const living = () => {
    const sleeper = spawn('sleep', ['30']);
    sleepers.push(sleeper);
    return sleeper.pid!;
  };
  afterEach(() => {
    for (const sleeper of sleepers.splice(0)) sleeper.kill();
    spawnSync('rm', ['-rf', join(dir, 'run')]);
  });

  it('is the lock the root programs take', () => {
    expect(script('printf %s "$ROOT_LOCK"').stdout).toBe(ROOT_LOCK);
  });

  it('is taken while the install runs, and released when it ends', () => {
    const run = script('take_lock "$LOCK" && cat "$LOCK" && printf " %s" "$$"', { LOCK: lock });
    expect(run.status).toBe(0);
    const [held, self] = run.stdout.split(' ');
    expect(held).toBe(self);
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(join(dir, 'run'))).toEqual([]);
  });

  it('is refused while a living owner holds it, which keeps it', () => {
    const owner = String(living());
    script('mkdir -p "$(dirname "$LOCK")"; printf %s "$OWNER" >"$LOCK"', {
      LOCK: lock,
      OWNER: owner,
    });
    expect(script('take_lock "$LOCK"', { LOCK: lock }).status).toBe(1);
    expect(readFileSync(lock, 'utf8')).toBe(owner);
    expect(readdirSync(join(dir, 'run'))).toEqual(['compose.lock']);
  });

  it('takes over a lock whose owner is gone', () => {
    const sleeper = spawnSync('bash', ['-c', 'sleep 0 & echo $!'], { encoding: 'utf8' });
    script('mkdir -p "$(dirname "$LOCK")"; printf %s "$OWNER" >"$LOCK"', {
      LOCK: lock,
      OWNER: sleeper.stdout.trim(),
    });
    expect(script('take_lock "$LOCK"', { LOCK: lock }).status).toBe(0);
  });

  it('counts a lock without a pid for a minute', () => {
    script('mkdir -p "$(dirname "$LOCK")"; : >"$LOCK"', { LOCK: lock });
    expect(script('take_lock "$LOCK"', { LOCK: lock }).status).toBe(1);
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(lock, old, old);
    expect(script('take_lock "$LOCK"', { LOCK: lock }).status).toBe(0);
  });

  it('--update under laris-update uses its lock; run by hand, takes it like any install', () => {
    const update = (owner: string) => {
      script('mkdir -p "$(dirname "$LOCK")"; printf %s "$OWNER" >"$LOCK"', {
        LOCK: lock,
        OWNER: owner,
      });
      return script('UPDATE=1; ROOT_LOCK="$LOCK"; hold_lock', { LOCK: lock });
    };
    // The test's own process starts bash, as laris-update starts install.sh: its lock stays.
    expect(update(String(process.pid)).status).toBe(0);
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
    const busy = update(String(living()));
    expect(busy.status).toBe(1);
    expect(busy.stderr).toContain('A backup, restore or disk change is running');
    spawnSync('rm', ['-f', lock]);
    expect(script('UPDATE=1; ROOT_LOCK="$LOCK"; hold_lock', { LOCK: lock }).status).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('a hand-run install refuses while another operation holds it', () => {
    script('mkdir -p "$(dirname "$LOCK")"; printf %s "$OWNER" >"$LOCK"', {
      LOCK: lock,
      OWNER: String(living()),
    });
    const run = script('UPDATE=0; ROOT_LOCK="$LOCK"; hold_lock', { LOCK: lock });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('A backup, restore or disk change is running');
  });
});

describe('the installer’s database dumps', () => {
  it('keeps the newest three', () => {
    const dir = mkdtempSync(join(tmpdir(), 'laris-install-dumps-'));
    const names = [1, 2, 3, 4, 5].map((n) => `laris-0.1.${n}-20261105-12000${n}.dump`);
    names.forEach((name, i) => {
      writeFileSync(join(dir, name), 'dump');
      const at = new Date(Date.now() - (10 - i) * 60_000);
      utimesSync(join(dir, name), at, at);
    });
    writeFileSync(join(dir, 'notes.txt'), 'not a dump');
    expect(script('prune_dumps "$DIR"', { DIR: dir }).status).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([...names.slice(2), 'notes.txt'].sort());
  });
});
