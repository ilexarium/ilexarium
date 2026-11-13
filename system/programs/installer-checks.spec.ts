import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT_LOCK, startTime } from './lib/lock.mts';

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

// A script over the installer's own files: $1 common.sh, $2 checks.sh, $3 platform.sh,
// $4 packages.sh.
const script = (body: string, env: Record<string, string> = {}) =>
  spawnSync(
    'bash',
    [
      '-c',
      `source "$1"; source "$2"; source "$3"; source "$4"; ${body}`,
      '_',
      COMMON,
      CHECKS,
      PLATFORM,
      PACKAGES,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );

describe('the installer’s questions', () => {
  it('--yes answers them and keeps each question in the output', () => {
    const run = script('UPDATE=0 ASSUME_YES=1; confirm "Install Something (from somewhere)?"');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('    Install Something (from somewhere)? yes (--yes)\n');
  });

  it('the question about Borg names where it comes from on each system', () => {
    // No Borg on the machine, and no terminal: the installer stops with its question.
    const asked = (os: string, version: string) =>
      script('borg() { return 127; }; UPDATE=0 ASSUME_YES=0; ensure_borg', {
        OS_ID: os,
        OS_VERSION: version,
      }).stderr;
    expect(asked('ubuntu', '24.04')).toContain(
      "Install Borg 1.4 for backups (the Borg project's own build 1.4.5 from github.com/borgbackup/borg, checked against the SHA-256 in this installer)? — run again with --yes",
    );
    expect(asked('debian', '13')).toContain("Install Borg 1.4 for backups (Debian's package)?");
    expect(asked('debian', '12')).toContain(
      "Install Borg 1.4 for backups (Debian's package from bookworm-backports)?",
    );
    expect(asked('arch', '')).toContain("Install Borg 1.4 for backups (Arch's package)?");
  });
});

describe('Borg on Ubuntu 24.04: the Borg project’s own build', () => {
  it('one exact file per CPU, with its SHA-256; none for any other CPU', () => {
    expect(call('borg_build', 'amd64')).toBe(
      'borg-linux-glibc231-x86_64.tgz b6cba6b5eee19d51fbf4d89c6090dd40647b856755fffe2e26417365536f2c58',
    );
    expect(call('borg_build', 'arm64')).toBe(
      'borg-linux-glibc235-arm64-gh.tgz 579d977d4eafd5761aee51e4a5bd3c52a5533a4391393d465324f675d14d3bd9',
    );
    expect(call('borg_build', 'armhf')).toBe('');
  });

  // A build shaped like the release's (one folder, borg-dir), served by a fake curl that notes the
  // address it was asked for; chown is a no-op (the test isn't root).
  const dir = mkdtempSync(join(tmpdir(), 'ilex-install-borg-'));
  mkdirSync(join(dir, 'src', 'borg-dir'), { recursive: true });
  writeFileSync(join(dir, 'src', 'borg-dir', 'borg.exe'), '#!/bin/sh\necho borg 1.4.5\n', {
    mode: 0o755,
  });
  execFileSync('tar', ['-czf', join(dir, 'build.tgz'), '-C', join(dir, 'src'), 'borg-dir']);
  const buildSum = createHash('sha256')
    .update(readFileSync(join(dir, 'build.tgz')))
    .digest('hex');
  const install = (sum: string) => {
    spawnSync('rm', [
      '-rf',
      join(dir, 'lib'),
      join(dir, 'bin'),
      join(dir, 'tmp'),
      join(dir, 'url'),
    ]);
    for (const folder of ['bin', 'lib', 'tmp']) mkdirSync(join(dir, folder));
    // Under set -e, as install.sh runs.
    return script(
      'set -e; curl() { printf %s "${@: -1}" >"$DIR/url"; cp "$DIR/build.tgz" "${@: -2:1}"; }; chown() { :; }; ' +
        'BORG_HOME="$DIR/lib/borg" BORG_LINK="$DIR/bin/borg"; ' +
        'install_borg_build borg-linux-glibc235-arm64-gh.tgz "$SUM"',
      { DIR: dir, SUM: sum, TMPDIR: join(dir, 'tmp') },
    );
  };

  it('installs the build from the Borg project’s release page, linked as borg', () => {
    const run = install(buildSum);
    expect(run.status).toBe(0);
    expect(readFileSync(join(dir, 'url'), 'utf8')).toBe(
      'https://github.com/borgbackup/borg/releases/download/1.4.5/borg-linux-glibc235-arm64-gh.tgz',
    );
    expect(readlinkSync(join(dir, 'bin', 'borg'))).toBe(join(dir, 'lib', 'borg', 'borg.exe'));
    expect(execFileSync(join(dir, 'bin', 'borg'), { encoding: 'utf8' })).toBe('borg 1.4.5\n');
    expect(readdirSync(join(dir, 'tmp'))).toEqual([]);
  });

  it('refuses a download whose SHA-256 is not the one written in the installer', () => {
    const run = install('0'.repeat(64));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'The downloaded borg-linux-glibc235-arm64-gh.tgz is not the Borg 1.4.5 build this installer knows (its SHA-256 differs): nothing was installed',
    );
    expect(existsSync(join(dir, 'lib', 'borg'))).toBe(false);
    expect(existsSync(join(dir, 'bin', 'borg'))).toBe(false);
    expect(readdirSync(join(dir, 'tmp'))).toEqual([]);
  });
});

describe('the installer’s lock (the root programs’ own)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ilex-install-lock-'));
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
    const [held, , self] = run.stdout.split(' ');
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

  it('writes its start time beside its pid, as lock.mts does', () => {
    const run = script('take_lock "$LOCK" && cat "$LOCK"', { LOCK: lock });
    const [pid, start] = run.stdout.split(' ');
    expect(pid).toMatch(/^[1-9]\d*$/);
    expect(start).toMatch(/^\d+$/);
  });

  it('takes over a lock whose pid now belongs to another process (its start time differs)', () => {
    const owner = living();
    const start = startTime(owner)!;
    const hold = (text: string) =>
      script('mkdir -p "$(dirname "$LOCK")"; printf %s "$TEXT" >"$LOCK"', {
        LOCK: lock,
        TEXT: text,
      });
    hold(`${owner} ${start}`);
    expect(script('take_lock "$LOCK"', { LOCK: lock }).status).toBe(1);
    hold(`${owner} ${Number(start) + 1}`);
    expect(script('take_lock "$LOCK"', { LOCK: lock }).status).toBe(0);
  });

  it('counts a lock without a pid for a minute', () => {
    script('mkdir -p "$(dirname "$LOCK")"; : >"$LOCK"', { LOCK: lock });
    expect(script('take_lock "$LOCK"', { LOCK: lock }).status).toBe(1);
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(lock, old, old);
    expect(script('take_lock "$LOCK"', { LOCK: lock }).status).toBe(0);
  });

  it('--update under ilex-update uses its lock; run by hand, takes it like any install', () => {
    const update = (owner: string) => {
      script('mkdir -p "$(dirname "$LOCK")"; printf %s "$OWNER" >"$LOCK"', {
        LOCK: lock,
        OWNER: owner,
      });
      return script('UPDATE=1; ROOT_LOCK="$LOCK"; hold_lock', { LOCK: lock });
    };
    // The test's own process starts bash, as ilex-update starts install.sh: its lock stays.
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
    const dir = mkdtempSync(join(tmpdir(), 'ilex-install-dumps-'));
    const names = [1, 2, 3, 4, 5].map((n) => `ilex-0.1.${n}-20261105-12000${n}.dump`);
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
