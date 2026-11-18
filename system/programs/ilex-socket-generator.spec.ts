// ilex-socket-generator (system/systemd/), the generator that writes where ilex.socket listens
// from the machine's settings: run as systemd runs it, against a pretend app.env.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The generator's function `fn`, with SETTINGS in the pretend folder. */
function call(fn: string, ...args: string[]) {
  return spawnSync(
    'bash',
    ['-c', 'source "$1"; SETTINGS="$2/app.env"; "${@:3}"', '_', GENERATOR, dir, fn, ...args],
    { encoding: 'utf8' },
  );
}

function generate(settings: string) {
  writeFileSync(join(dir, 'app.env'), settings);
  const run = call('main', join(dir, 'normal'), join(dir, 'early'), join(dir, 'late'));
  const read = (unit: string) => {
    const file = join(dir, `normal/${unit}.d/listen.conf`);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };
  return { ...run, dropIn: read('ilex.socket'), httpsDropIn: read('ilex-https.socket') };
}

describe('ilex-socket-generator', () => {
  it('writes the addresses from app.env as a drop-in for ilex.socket', () => {
    const { dropIn, status } = generate('HOST=127.0.0.1\nPORT=3300\nDATABASE_URL=postgres://x\n');
    expect(status).toBe(0);
    expect(dropIn).toBe(
      `[Socket]\nListenStream=127.0.0.1:3300\n${IPV6 ? 'ListenStream=[::1]:3300\n' : ''}`,
    );
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

  it('HTTPS on the network: ilex-https.socket from HTTPS_HOST and HTTPS_PORT (3443 unset)', () => {
    const { dropIn, httpsDropIn, status } = generate(
      'HOST=127.0.0.1\nPORT=3000\nHTTPS_HOST=0.0.0.0\nHTTPS_PORT=3443\n',
    );
    expect(status).toBe(0);
    expect(dropIn).toMatch(/^\[Socket\]\nListenStream=127.0.0.1:3000\n/);
    expect(httpsDropIn).toBe(
      `[Socket]\nListenStream=0.0.0.0:3443\n${IPV6 ? 'ListenStream=[::1]:3443\n' : ''}`,
    );
    expect(generate('HTTPS_HOST=192.168.1.10\n').httpsDropIn).toBe(
      '[Socket]\nListenStream=192.168.1.10:3443\n',
    );
    expect(generate('HTTPS_HOST="100.64.0.7"\nHTTPS_PORT=8443\n').httpsDropIn).toBe(
      '[Socket]\nListenStream=100.64.0.7:8443\n',
    );
  });

  it('no HTTPS_HOST (this machine only): no address for ilex-https.socket, nothing said', () => {
    for (const settings of [
      'HOST=127.0.0.1\n',
      'HTTPS_HOST=\n',
      'HTTPS_HOST=""\nHTTPS_PORT=3443\n',
    ]) {
      const { dropIn, httpsDropIn, status, stderr } = generate(settings);
      expect(status, settings).toBe(0);
      expect(dropIn, settings).not.toBeNull();
      expect(httpsDropIn, settings).toBeNull();
      expect(stderr, settings).toBe('');
    }
  });

  it('HTTPS settings that aren’t an address and a port: no HTTPS address, the plain one kept', () => {
    for (const settings of [
      'HTTPS_HOST=taragui.local\n',
      'HTTPS_HOST=0.0.0.0\nHTTPS_PORT=0\n',
      'HTTPS_HOST=0.0.0.0; touch x\n',
      'HTTPS_HOST="0.0.0.0\nListenStream=0.0.0.0:22"\n',
    ]) {
      const { dropIn, httpsDropIn, status, stderr } = generate(settings);
      expect(status, settings).toBe(0);
      expect(dropIn, settings).not.toBeNull();
      expect(httpsDropIn, settings).toBeNull();
      expect(stderr, settings).toMatch(/HTTPS_HOST or HTTPS_PORT .* is not an address and a port/);
    }
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
      'HTTPS_HOST=0.0.0.0\nHTTPS_PORT= 8443\r\n',
    ]) {
      writeFileSync(join(dir, 'app.env'), settings);
      for (const name of ['HOST', 'PORT', 'HTTPS_HOST', 'HTTPS_PORT']) {
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
