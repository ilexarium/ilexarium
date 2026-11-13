import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT_LOCK, startTime } from './lib/lock.mts';

const CHECKS = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/checks.sh');
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/packages.sh');
const COMMON = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/common.sh');
const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/platform.sh');
const FILES = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/files.sh');

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
    expect(call('os_family', 'ubuntu', '26.04', 'debian')).toBe('apt');
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
      script(
        'borg() { return 127; }; BORG_BY_HAND=/nonexistent/borg UPDATE=0 ASSUME_YES=0; ensure_borg',
        { OS_ID: os, OS_VERSION: version },
      ).stderr;
    expect(asked('debian', '13')).toContain("Install Borg 1.4 for backups (Debian's package)?");
    expect(asked('debian', '12')).toContain(
      "Install Borg 1.4 for backups (Debian's package from bookworm-backports)?",
    );
    expect(asked('ubuntu', '26.04')).toContain("Install Borg 1.4 for backups (Ubuntu's package)?");
    expect(asked('arch', '')).toContain("Install Borg 1.4 for backups (Arch's package)?");
  });
});

describe('Borg on Ubuntu 24.04: installed by the person first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ilex-install-borg-'));
  const fakeBorg = (folder: string, version: string) => {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, 'borg'), `#!/bin/sh\necho borg ${version}\n`, { mode: 0o755 });
  };
  // As an update from the app runs it: under set -e, with a PATH that has no /usr/local/bin.
  const ensure = (body: string, path: string, byHand = join(dir, 'missing', 'borg')) =>
    script(`set -e; BORG_BY_HAND="$BY_HAND" OS_ID=ubuntu OS_VERSION=24.04; ${body}`, {
      BY_HAND: byHand,
      PATH: `${path}:/usr/sbin:/usr/bin:/sbin:/bin`,
    });
  fakeBorg('ubuntu-bin', '1.2.8');
  fakeBorg('local-bin', '1.4.5');

  it('without Borg 1.4 the installer stops and says what to do, asking nothing', () => {
    const run = ensure('UPDATE=0 ASSUME_YES=1; ensure_borg', join(dir, 'ubuntu-bin'));
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(
      'Ubuntu 24.04 has only Borg 1.2.8: install Borg 1.4 yourself first (https://borgbackup.readthedocs.io/en/1.4-maint/installation.html), in /usr/bin or /usr/local/bin, then run this again',
    );
  });

  it('goes on with a Borg 1.4 the person installed', () => {
    fakeBorg('usr-bin', '1.4.4');
    const run = ensure('UPDATE=1; ensure_borg; borg_path', join(dir, 'usr-bin'));
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe(`    Borg 1.4.4\n${join(dir, 'usr-bin', 'borg')}\n`);
  });

  it('finds one in /usr/local/bin on an update from the app, whose PATH has no /usr/local/bin', () => {
    const run = ensure(
      'root_only() { :; }; UPDATE=1; ensure_borg; borg_path',
      join(dir, 'ubuntu-bin'),
      join(dir, 'local-bin', 'borg'),
    );
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe(`    Borg 1.4.5\n${join(dir, 'local-bin', 'borg')}\n`);
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses a Borg in /usr/local/bin that is not root’s own',
    () => {
      const run = ensure(
        'UPDATE=1; ensure_borg',
        join(dir, 'ubuntu-bin'),
        join(dir, 'local-bin', 'borg'),
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        `${join(dir, 'local-bin', 'borg')} is not root's own (owned by someone else, or writable by others): fix it or remove it, then run again`,
      );
    },
  );

  it('root’s own: the file, through its links, and its folder owned by root, writable by no one else', () => {
    expect(holds('root_only', '/bin/sh')).toBe(true);
    if (process.getuid?.() !== 0)
      expect(holds('root_only', join(dir, 'local-bin', 'borg'))).toBe(false);
    expect(holds('root_only', join(dir, 'missing', 'borg'))).toBe(false);
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

describe('what runs when the installer ends', () => {
  it('the last added first, each given the exit status, also after a failure', () => {
    const run = script(
      'a() { echo "a $1"; false; }; b() { echo "b $1"; }; on_exit a; on_exit b; exit 3',
    );
    expect(run.status).toBe(3);
    expect(run.stdout).toBe('b 3\na 3\n');
  });
});

describe('the app’s port before a first install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ilex-install-port-'));
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });
  const listen = (host: string) =>
    new Promise<number>((resolve) => {
      server = createServer().listen(0, host, () =>
        resolve((server!.address() as { port: number }).port),
      );
    });
  const checkPort = (settings: string, installed = '') => {
    writeFileSync(join(dir, 'app.env'), settings);
    return script('source "$FILES"; ETC="$DIR"; OLD_VERSION="$INSTALLED"; check_port', {
      FILES,
      DIR: dir,
      INSTALLED: installed,
    });
  };

  it('refuses when another program answers there, before anything changed', async () => {
    const port = await listen('127.0.0.1');
    const run = checkPort(`PORT=${port}\n`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`Another program answers on port ${port} (127.0.0.1;`);
    expect(run.stderr).toContain(`PORT=<port> in ${dir}/app.env`);
  });

  it('also on ::1 and on the address HOST names', async () => {
    if (existsSync('/proc/net/if_inet6')) {
      const port = await listen('::1');
      expect(checkPort(`PORT=${port}\n`).stderr).toContain(`(::1;`);
      server?.close();
    }
    const port = await listen('127.0.0.2');
    expect(checkPort(`HOST=127.0.0.2\nPORT=${port}\n`).status).toBe(1);
  });

  it('a free port passes; an update keeps its own port (the app or ilex.socket answers there)', async () => {
    const port = await listen('127.0.0.1');
    expect(checkPort(`PORT=${port}\n`, '0.2.2').status).toBe(0);
    server?.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(checkPort(`PORT=${port}\n`).status).toBe(0);
  });
});
