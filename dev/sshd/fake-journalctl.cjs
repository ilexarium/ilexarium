#!/usr/bin/node
// Development and tests only: `journalctl` for the dev SSH server, which has no journald.
// Three boots of sample lines — this one keeps growing, a line every
// 5 s since the container's first read — answered the way journalctl does with `--output=json`:
// a byte array for a message that isn't UTF-8, a repeated field, the filters and cursors the
// helper passes. As root it sees everything; as anyone else only their own lines (no journal
// group here), like journald.
const fs = require('node:fs');

const START = '/tmp/fake-journal-start';
const BOOTS = [
  { id: '1a'.repeat(16), first: 1_792_400_000, lines: 300 },
  { id: '2b'.repeat(16), first: 1_792_480_000, lines: 300 },
  { id: '3c'.repeat(16), first: null, lines: 1200 },
];
const UNITS = [
  ['nginx.service', 'nginx', 6, (i) => `GET /index.html 200 ${i}ms`],
  ['proton.VPN.service', 'protonvpn', 3, () => 'Connection to the VPN server failed: timeout'],
  ['backup-sync.service', 'rsync', 4, (i) => `skipping file ${i}: permission denied`],
  ['ssh.service', 'sshd', 6, () => 'Accepted password for anna from 127.0.0.1 port 40112 ssh2'],
  [null, 'kernel', 7, (i) => `eth0: link state change ${i}`],
  ['user@1500.service', 'anna-script', 6, (i) => `anna’s own job, round ${i}`],
];

const started = () => {
  try {
    return Number(fs.readFileSync(START, 'utf8'));
  } catch {
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(START, String(now), { mode: 0o666 });
    return now;
  }
};

/** Every entry of a boot, oldest first. */
function entries(bootIndex) {
  const boot = BOOTS[bootIndex];
  const current = bootIndex === BOOTS.length - 1;
  const first = boot.first ?? started() - boot.lines * 5;
  const count = current ? boot.lines + Math.floor((Date.now() / 1000 - started()) / 5) : boot.lines;
  return Array.from({ length: count }, (_, i) => {
    const [unit, identifier, priority, message] = UNITS[i % UNITS.length];
    const entry = {
      __CURSOR: `s=fake;i=${(bootIndex * 100_000 + i).toString(16)};b=${boot.id}`,
      __REALTIME_TIMESTAMP: String((first + i * 5) * 1_000_000),
      _BOOT_ID: boot.id,
      PRIORITY: String(priority),
      SYSLOG_IDENTIFIER: identifier,
      _UID: identifier === 'anna-script' ? '1500' : '0',
      MESSAGE: message(i),
    };
    if (unit) entry._SYSTEMD_UNIT = unit;
    if (identifier !== 'kernel') entry._PID = String(400 + (i % UNITS.length));
    if (i % 97 === 5) entry.MESSAGE = [...Buffer.from('caf\xe9 latin-1: ', 'latin1'), 0xff];
    if (i % 101 === 7) entry.SYSLOG_IDENTIFIER = [identifier, 'again'];
    return entry;
  });
}

const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const own = (entry) => process.getuid() === 0 || entry._UID === String(process.getuid());

if (args.includes('--list-boots')) {
  const boots = BOOTS.map((boot, index) => {
    const all = entries(index);
    return {
      index: index - (BOOTS.length - 1),
      boot_id: boot.id,
      first_entry: Number(all[0].__REALTIME_TIMESTAMP),
      last_entry: Number(all.at(-1).__REALTIME_TIMESTAMP),
    };
  });
  process.stdout.write(`${JSON.stringify(boots)}\n`);
  process.exit(0);
}

const boot = option('boot') ?? '0';
const bootIndex = /^-?\d+$/.test(boot)
  ? BOOTS.length - 1 + Number(boot)
  : BOOTS.findIndex((b) => b.id === boot);
if (!BOOTS[bootIndex]) {
  process.stderr.write(`No journal boot entry found for the specified boot (${boot}).\n`);
  process.exit(1);
}
const priority = Number(option('priority') ?? 7);
const unit = option('unit');
let list = entries(bootIndex).filter(
  (e) => own(e) && Number(e.PRIORITY) <= priority && (!unit || e._SYSTEMD_UNIT === unit),
);
const after = option('after-cursor');
const cursor = option('cursor');
const at = (c) => {
  const i = list.findIndex((e) => e.__CURSOR === c);
  if (i < 0) {
    process.stderr.write('Failed to seek to cursor: Invalid argument\n');
    process.exit(1);
  }
  return i;
};
const reverse = args.includes('--reverse');
const lines = Number(option('lines') ?? list.length);
if (after) list = list.slice(at(after) + 1, at(after) + 1 + lines);
else if (cursor) list = list.slice(Math.max(0, at(cursor) + 1 - lines), at(cursor) + 1);
else list = list.slice(-lines);
if (reverse) list.reverse();
for (const entry of list) {
  const { _UID, ...shown } = entry;
  process.stdout.write(`${JSON.stringify(shown)}\n`);
}
