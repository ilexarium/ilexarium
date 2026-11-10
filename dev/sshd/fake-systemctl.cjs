#!/usr/bin/node
// Development and tests only: `systemctl` for the dev SSH server, which has no systemd
// (docs/plans/system_services.md). A few sample service units — a failed one, Ilexarium's own and one
// it needs among them — answered the way systemd does (JSON lists, `key=value` for `show`).
// Start, stop and restart need root (ilex-root, through anna's sudo) and change the units' state,
// kept in /tmp for the container's life. Anything else: unknown, like a command it doesn't have.
const fs = require('node:fs');

const STATE = '/tmp/fake-systemd.json';
const SAMPLES = {
  'nginx.service': ['A high performance web server', 'active', 'running', 'enabled'],
  'proton.VPN.service': ['Proton VPN Daemon', 'failed', 'failed', 'enabled'],
  'backup-sync.service': ['Copies the photos to the NAS', 'inactive', 'dead', 'disabled'],
  'ilex.service': ['Ilexarium', 'active', 'running', 'enabled'],
  'ssh.service': ['OpenBSD Secure Shell server', 'active', 'running', 'enabled'],
  'docker.service': ['Docker Application Container Engine', 'active', 'running', 'enabled'],
  'getty@tty1.service': ['Getty on tty1', 'active', 'running', null],
};

const read = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    const units = {};
    for (const [name, [description, active, sub, enabled]] of Object.entries(SAMPLES)) {
      units[name] = { description, active, sub, enabled, since: 1792573340, pid: 400 };
    }
    return units;
  }
};
const write = (units) => fs.writeFileSync(STATE, JSON.stringify(units), { mode: 0o644 });
const fail = (code, message) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const args = process.argv.slice(2);
const unitName = args[args.indexOf('--') + 1];
const units = read();
switch (args[0]) {
  case 'list-units':
    process.stdout.write(
      JSON.stringify(
        Object.entries(units).map(([unit, u]) => ({
          unit,
          load: 'loaded',
          active: u.active,
          sub: u.sub,
          description: u.description,
        })),
      ) + '\n',
    );
    break;
  case 'list-unit-files':
    process.stdout.write(
      JSON.stringify(
        Object.entries(units)
          .filter(([, u]) => u.enabled)
          .map(([unit, u]) => ({ unit_file: unit, state: u.enabled, preset: null })),
      ) + '\n',
    );
    break;
  case 'show': {
    const u = units[unitName];
    const running = u && u.active === 'active';
    const values = {
      Id: unitName,
      Names: unitName,
      Description: u ? u.description : '',
      LoadState: u ? 'loaded' : 'not-found',
      ActiveState: u ? u.active : 'inactive',
      SubState: u ? u.sub : 'dead',
      UnitFileState: (u && u.enabled) || '',
      FragmentPath: u ? `/usr/lib/systemd/system/${unitName}` : '',
      MainPID: running ? String(u.pid) : '0',
      MemoryCurrent: running ? '16023552' : '[not set]',
      Result: u && u.active === 'failed' ? 'exit-code' : 'success',
      ExecMainStatus: u && u.active === 'failed' ? '1' : '0',
      NRestarts: '0',
      StateChangeTimestamp: u ? `@${u.since}` : '',
    };
    const asked = (args.find((a) => a.startsWith('--property=')) || '').slice(11).split(',');
    for (const key of asked) if (key in values) process.stdout.write(`${key}=${values[key]}\n`);
    break;
  }
  case 'start':
  case 'stop':
  case 'restart': {
    if (process.getuid() !== 0)
      fail(1, `Failed to ${args[0]} ${unitName}: Interactive authentication required.`);
    const u = units[unitName];
    if (!u) fail(5, `Failed to ${args[0]} ${unitName}: Unit ${unitName} not found.`);
    const up = args[0] !== 'stop';
    Object.assign(u, {
      active: up ? 'active' : 'inactive',
      sub: up ? 'running' : 'dead',
      since: Math.floor(Date.now() / 1000),
      pid: up ? u.pid + 1 : u.pid,
    });
    write(units);
    break;
  }
  default:
    fail(1, `Unknown command verb '${args[0]}'.`);
}
