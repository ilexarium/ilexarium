// ilex-socket-generator (system/systemd/), the generator that writes where ilex.socket listens
// from the machine's settings: run as systemd runs it, against a pretend app.env and ilex.service.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const GENERATOR = join(HERE, '../systemd/ilex-socket-generator');
const FILES = join(HERE, '../install/lib/files.sh');
const IPV6 = existsSync('/proc/net/if_inet6');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ilex-socket-'));
  for (const folder of ['normal', 'early', 'late']) mkdirSync(join(dir, folder));
  writeFileSync(join(dir, 'ilex.service'), '[Service]\nSockets=ilex.socket\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The generator's function `fn`, with SETTINGS and APP_UNIT in the pretend folder. */
function call(fn: string, ...args: string[]) {
  return spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; SETTINGS="$2/app.env"; APP_UNIT="$2/ilex.service"; "${@:3}"',
      '_',
      GENERATOR,
      dir,
      fn,
      ...args,
    ],
    { encoding: 'utf8' },
  );
}

function generate(settings: string) {
  writeFileSync(join(dir, 'app.env'), settings);
  const run = call('main', join(dir, 'normal'), join(dir, 'early'), join(dir, 'late'));
  const dropIn = join(dir, 'normal/ilex.socket.d/listen.conf');
  return { ...run, dropIn: existsSync(dropIn) ? readFileSync(dropIn, 'utf8') : null };
}

describe('ilex-socket-generator', () => {
  it('writes the addresses from app.env as a drop-in for ilex.socket', () => {
    const { dropIn, status } = generate('HOST=127.0.0.1\nPORT=3300\nDATABASE_URL=postgres://x\n');
    expect(status).toBe(0);
    expect(dropIn).toBe(
      `[Socket]\nListenStream=127.0.0.1:3300\n${IPV6 ? 'ListenStream=[::1]:3300\n' : ''}`,
    );
    expect(existsSync(join(dir, 'early/ilex.socket'))).toBe(false);
  });

  it('masks the socket for an app unit that binds its port itself (an older version put back)', () => {
    writeFileSync(join(dir, 'ilex.service'), '[Service]\nExecStart=/usr/bin/node dist/main.js\n');
    const { dropIn, status } = generate('HOST=127.0.0.1\nPORT=3000\n');
    expect(status).toBe(0);
    expect(dropIn).toBeNull();
    expect(readlinkSync(join(dir, 'early/ilex.socket'))).toBe('/dev/null');
  });

  it('settings that aren’t an address and a port: no address at all, and says why', () => {
    for (const settings of [
      'HOST=localhost\n',
      'HOST=127.0.0.1\nPORT=0\n',
      'PORT=70000\n',
      'PORT=80x\n',
      'HOST=127.0.0.1]:1\n',
      'HOST=%H\n',
      'HOST=::1 \nPORT=3000 4000\n',
    ]) {
      const { dropIn, status, stderr } = generate(settings);
      expect(status, settings).toBe(0);
      expect(dropIn, settings).toBeNull();
      expect(stderr, settings).toMatch(/HOST or PORT .* is not an address and a port/);
    }
  });

  it('reads the settings as text: nothing in them runs, nothing but the address reaches the unit', () => {
    const ran = join(dir, 'ran');
    for (const settings of [
      `HOST=$(touch ${ran})\n`,
      `HOST=\`touch ${ran}\`\nPORT=3000\n`,
      `HOST=127.0.0.1; touch ${ran}\n`,
      'HOST="127.0.0.1\nListenStream=0.0.0.0:22"\n',
      'HOST=127.0.0.1\nPORT=3000\nListenStream=0.0.0.0:22\n',
    ]) {
      const { dropIn } = generate(settings);
      expect(existsSync(ran), settings).toBe(false);
      expect(dropIn ?? '', settings).not.toContain('0.0.0.0:22');
    }
  });

  it('the address pairs: 127.0.0.1 and 0.0.0.0 with ::1, ::1 with 127.0.0.1, others alone', () => {
    const lines = (host: string, ipv6 = 'yes') => call('listen_lines', host, '3000', ipv6).stdout;
    expect(lines('')).toBe('ListenStream=127.0.0.1:3000\nListenStream=[::1]:3000\n');
    expect(lines('127.0.0.1')).toBe('ListenStream=127.0.0.1:3000\nListenStream=[::1]:3000\n');
    expect(lines('127.0.0.1', 'no')).toBe('ListenStream=127.0.0.1:3000\n');
    expect(lines('0.0.0.0')).toBe('ListenStream=0.0.0.0:3000\nListenStream=[::1]:3000\n');
    expect(lines('::1')).toBe('ListenStream=[::1]:3000\nListenStream=127.0.0.1:3000\n');
    expect(lines('::')).toBe('ListenStream=[::]:3000\n');
    expect(lines('192.168.1.10')).toBe('ListenStream=192.168.1.10:3000\n');
    expect(lines('fd00::5')).toBe('ListenStream=[fd00::5]:3000\n');
    expect(call('listen_lines', '', '', 'no').stdout).toBe('ListenStream=127.0.0.1:3000\n');
  });

  it('reads HOST and PORT as the installer does (app_setting)', () => {
    for (const settings of [
      '',
      'PORT=8080\n',
      'HOST=::1\n',
      'PORT=3000\nPORT=4000\n',
      'HOST="0.0.0.0"\nPORT=\'8080\'\n',
      '  PORT=8080 \r\nHOST=::1\r\n',
      '# HOST=10.0.0.1\nHOST=127.0.0.1\n',
    ]) {
      writeFileSync(join(dir, 'app.env'), settings);
      for (const name of ['HOST', 'PORT']) {
        const installer = execFileSync(
          'bash',
          ['-c', 'source "$1"; ETC="$2"; app_setting "$3"', '_', FILES, dir, name],
          { encoding: 'utf8' },
        );
        expect(call('setting', name).stdout, `${name} in ${JSON.stringify(settings)}`).toBe(
          installer,
        );
      }
    }
  });
});
