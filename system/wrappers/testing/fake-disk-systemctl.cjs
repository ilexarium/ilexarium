// A fake `systemctl` for homelab-disk.spec.ts (copied beside the test's files, with a shebang).
// Records every call in systemctl-calls.jsonl. `enable --now` mounts (adds the unit's folder to the
// pretend mountinfo), `disable --now` unmounts; fail-enable / busy (files) make them fail; other
// calls (daemon-reload, enable alone) only succeed.
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'systemctl-calls.jsonl'), JSON.stringify({ args }) + '\n');
const mountinfo = path.join(dir, 'host', 'proc', 'self', 'mountinfo');
const unitFile = (unit) => fs.readFileSync(path.join(dir, 'units', unit), 'utf8');
const field = (text, key) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)[1];

if (args[0] === 'enable' && args[1] === '--now') {
  if (fs.existsSync(path.join(dir, 'fail-enable'))) {
    process.stderr.write('Job for x.mount failed. See "journalctl -xeu x.mount" for details.\n');
    process.exit(1);
  }
  const text = unitFile(args[2]);
  const uuid = field(text, 'What').split('/').pop();
  const name = path.basename(
    fs.readlinkSync(path.join(dir, 'host', 'dev', 'disk', 'by-uuid', uuid)),
  );
  const number = fs
    .readFileSync(path.join(dir, 'host', 'sys', 'class', 'block', name, 'dev'), 'utf8')
    .trim();
  fs.appendFileSync(
    mountinfo,
    `500 1 ${number} / ${field(text, 'Where')} rw - ${field(text, 'Type')} /dev/${name} rw\n`,
  );
} else if (args[0] === 'disable' && args[1] === '--now') {
  if (fs.existsSync(path.join(dir, 'busy'))) {
    process.stderr.write('umount: target is busy.\n');
    process.exit(1);
  }
  const where = field(unitFile(args[2]), 'Where');
  const lines = fs
    .readFileSync(mountinfo, 'utf8')
    .split('\n')
    .filter((l) => l && l.split(' ')[4] !== where);
  fs.writeFileSync(mountinfo, lines.map((l) => `${l}\n`).join(''));
}
process.exit(0);
