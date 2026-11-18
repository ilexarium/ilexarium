import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROOT_LOCK, startTime } from './lib/lock.mts';

const CHECKS = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/checks.sh');
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/packages.sh');
const COMMON = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/common.sh');
const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/platform.sh');
const FILES = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/files.sh');
const HTTPS = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/https.sh');
const TEST_CERT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../apps/server/test/fixtures/tls/cert.pem',
);

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

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
  const checkPort = (settings: string, installed = '', open = '0') => {
    writeFileSync(join(dir, 'app.env'), settings);
    return script(
      'source "$FILES"; source "$HTTPS"; ETC="$DIR"; OLD_VERSION="$INSTALLED"; OPEN_ON_NETWORK="$OPEN"; check_port',
      { FILES, HTTPS, DIR: dir, INSTALLED: installed, OPEN: open },
    );
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

  it('opening it on the network: the HTTPS port too, with what to do', async () => {
    const port = await listen('127.0.0.1');
    const free = `PORT=${port + 1}\nHTTPS_PORT=${port}\n`;
    expect(checkPort(free).status).toBe(0);
    const run = checkPort(free, '', '1');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`Another program answers on port ${port}`);
    expect(run.stderr).toContain('HTTPS_PORT=<port>');
    expect(run.stderr).toContain('--local-only');
  });
});

describe('HTTPS on the network (the installer’s https.sh)', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ilex-install-https-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // write_file and chown as a test user can: no owners (written beside, then moved, as the real one).
  const https = (body: string, env: Record<string, string> = {}) =>
    script(
      `source "$FILES"; source "$HTTPS"; ETC="$DIR"; TLS_DIR="$DIR/tls"; APP_USER=ilex;
       write_file() { cat >"$1.new" && mv "$1.new" "$1"; }; chown() { :; }; ${body}`,
      { FILES, HTTPS, DIR: dir, ...env },
    );
  const choose = (flags: string, settings: string | null = null, installed = '') => {
    if (settings !== null) writeFileSync(join(dir, 'app.env'), settings);
    return https(
      `UPDATE=0 ASSUME_YES=0 LOCAL_ONLY=0 OLD_VERSION="$INSTALLED" ${flags}; choose_network </dev/null; echo "open=$OPEN_ON_NETWORK"`,
      { INSTALLED: installed },
    );
  };

  it('the first install asks; --yes opens it, --local-only doesn’t (also with --yes)', () => {
    const yes = choose('ASSUME_YES=1');
    expect(yes.stdout).toContain(
      "Open Ilexarium from other devices (it listens on all of this machine's addresses, https://<address>:3443)? yes (--yes)",
    );
    expect(yes.stdout).toContain('open=1');
    for (const flags of ['LOCAL_ONLY=1', 'LOCAL_ONLY=1 ASSUME_YES=1']) {
      const no = choose(flags);
      expect(no.stdout, flags).toContain('? no (--local-only)');
      expect(no.stdout, flags).toContain('open=0');
    }
  });

  it('no one to ask: stops before anything changed, saying how to answer', () => {
    const run = choose('');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('run again with --yes (opens it) or --local-only');
  });

  it('after the first install app.env decides: no question, --local-only ignored', () => {
    for (const [settings, installed] of [
      [null, '0.2.2'],
      ['HTTPS_HOST=\n', ''],
      ['  HTTPS_HOST=0.0.0.0\n', ''],
    ] as const) {
      const run = choose('LOCAL_ONLY=1', settings, installed);
      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain('Open Ilexarium');
      expect(run.stdout).toContain('--local-only: ignored');
      expect(run.stdout).toContain('open=0');
    }
  });

  it('the answer goes into app.env once, beside the settings there; its port if one was set', () => {
    writeFileSync(join(dir, 'app.env'), 'HOST=127.0.0.1\nPORT=3000\nDATABASE_URL=postgres://x\n');
    expect(https('OPEN_ON_NETWORK=1; ensure_https_settings; ensure_https_settings').status).toBe(0);
    const settings = readFileSync(join(dir, 'app.env'), 'utf8');
    expect(settings).toMatch(
      /^HOST=127\.0\.0\.1\nPORT=3000\nDATABASE_URL=postgres:\/\/x\n# Ilexarium on your network/,
    );
    expect(settings.match(/^HTTPS_HOST=0\.0\.0\.0$/gm)).toHaveLength(1);
    expect(settings).toMatch(/^HTTPS_PORT=3443$/m);

    writeFileSync(join(dir, 'app.env'), 'HTTPS_PORT=8443\n');
    https('OPEN_ON_NETWORK=1; ensure_https_settings');
    expect(readFileSync(join(dir, 'app.env'), 'utf8')).toMatch(
      /HTTPS_HOST=0\.0\.0\.0\nHTTPS_PORT=8443\n$/,
    );

    writeFileSync(join(dir, 'app.env'), 'PORT=3000\n');
    https('OPEN_ON_NETWORK=0; ensure_https_settings');
    expect(readFileSync(join(dir, 'app.env'), 'utf8')).toBe('PORT=3000\n');
  });

  it('the certificate’s names: the machine’s name (.local too), localhost, its addresses', () => {
    const names = (name: string, addresses: string) =>
      https(
        `machine_name() { printf %s "$NAME"; }; machine_addresses() { printf "$ADDRESSES"; }; certificate_names`,
        { NAME: name, ADDRESSES: addresses },
      ).stdout;
    expect(names('taragui', '192.168.1.5\n100.64.0.7\nfd00::5\n')).toBe(
      'DNS:taragui,DNS:taragui.local,DNS:localhost,IP:127.0.0.1,IP:::1,IP:192.168.1.5,IP:100.64.0.7,IP:fd00::5',
    );
    expect(names('server.home.arpa', '')).toBe(
      'DNS:server.home.arpa,DNS:localhost,IP:127.0.0.1,IP:::1',
    );
    expect(names('', '')).toBe('DNS:localhost,IP:127.0.0.1,IP:::1');
  });

  it('only a host name that can be a DNS name: nothing else reaches the certificate', () => {
    for (const [hostname, want] of [
      ['taragui', 'taragui'],
      ['my-server.lan', 'my-server.lan'],
      ['bad name', ''],
      ['x,IP:1.2.3.4', ''],
      ['-dash', ''],
      ['a\nCN = evil', ''],
    ]) {
      const got = https(
        `cat() { if [[ "$1" == /proc/sys/kernel/hostname ]]; then printf %s "$NAME"; else command cat "$@"; fi; }; machine_name`,
        { NAME: hostname! },
      ).stdout;
      expect(got, hostname).toBe(want);
    }
  });

  it('the address to open: HTTPS_HOST’s own, or the machine’s first', () => {
    const link = (settings: string, addresses = '192.168.1.5\n10.0.0.2\n') => {
      writeFileSync(join(dir, 'app.env'), settings);
      return https('machine_addresses() { printf "$ADDRESSES"; }; https_link', {
        ADDRESSES: addresses,
      }).stdout;
    };
    expect(link('HTTPS_HOST=0.0.0.0\n')).toBe('https://192.168.1.5:3443');
    expect(link('HTTPS_HOST=0.0.0.0\nHTTPS_PORT=8443\n')).toBe('https://192.168.1.5:8443');
    expect(link('HTTPS_HOST=100.64.0.7\n')).toBe('https://100.64.0.7:3443');
    expect(link('HTTPS_HOST=fd00::5\n')).toBe('https://[fd00::5]:3443');
    expect(link('HTTPS_HOST=0.0.0.0\n', '')).toBe("https://<this machine's address>:3443");
  });

  it('makes a self-signed certificate: its names, 825 days, not a CA, the key its own', () => {
    mkdirSync(join(dir, 'tls'));
    const run = https(
      'machine_name() { printf taragui; }; machine_addresses() { printf "192.168.1.5\n"; }; make_certificate',
    );
    expect(run.status, run.stderr).toBe(0);
    const cert = join(dir, 'tls/cert.pem');
    const text = execFileSync('openssl', ['x509', '-noout', '-text', '-in', cert], {
      encoding: 'utf8',
    });
    expect(text).toContain('DNS:taragui, DNS:taragui.local, DNS:localhost, IP Address:127.0.0.1');
    expect(text).toContain('IP Address:192.168.1.5');
    expect(text).toMatch(/Basic Constraints: critical\s+CA:FALSE/);
    expect(text).toContain('TLS Web Server Authentication');
    expect(text).toContain('ASN1 OID: prime256v1');
    const days = (end: string) =>
      Math.round((Date.parse(end.replace(/^notAfter=/, '')) - Date.now()) / 86_400_000);
    expect(
      days(
        execFileSync('openssl', ['x509', '-noout', '-enddate', '-in', cert], { encoding: 'utf8' }),
      ),
    ).toBe(825);
    const publicOf = (args: string[]) => execFileSync('openssl', args, { encoding: 'utf8' });
    expect(publicOf(['pkey', '-pubout', '-in', join(dir, 'tls/key.pem')])).toBe(
      publicOf(['x509', '-noout', '-pubkey', '-in', cert]),
    );
    expect(mode(join(dir, 'tls/key.pem'))).toBe('640');
    expect(readdirSync(join(dir, 'tls')).sort()).toEqual(['.self-signed', 'cert.pem', 'key.pem']);
    expect(https('self_made').status).toBe(0);
  });

  it('self-made only while the marker holds the certificate’s fingerprint', () => {
    mkdirSync(join(dir, 'tls'));
    execFileSync('cp', [TEST_CERT, join(dir, 'tls/cert.pem')]);
    expect(https('self_made').status).toBe(1);
    const fingerprint = https('fingerprint "$TLS_DIR/cert.pem"').stdout.trim();
    expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    writeFileSync(join(dir, 'tls/.self-signed'), `${fingerprint}\n`);
    expect(https('self_made').status).toBe(0);
    writeFileSync(join(dir, 'tls/.self-signed'), 'AA:BB\n');
    expect(https('self_made').status).toBe(1);
  });

  it('a certificate of the person’s own is kept, however near its end', () => {
    mkdirSync(join(dir, 'tls'));
    execFileSync('cp', [TEST_CERT, join(dir, 'tls/cert.pem')]);
    writeFileSync(join(dir, 'tls/key.pem'), 'theirs');
    writeFileSync(join(dir, 'app.env'), 'HTTPS_HOST=0.0.0.0\n');
    const run = https('runuser() { return 0; }; RENEW_DAYS=100000; ensure_certificate');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('(yours, kept)');
    expect(readFileSync(join(dir, 'tls/key.pem'), 'utf8')).toBe('theirs');
  });

  it('HTTPS off: no certificate made', () => {
    writeFileSync(join(dir, 'app.env'), 'PORT=3000\n');
    expect(https('ensure_certificate').status).toBe(0);
    expect(existsSync(join(dir, 'tls'))).toBe(false);
  });
});
