// A fake `systemctl` for homelab-backup.spec.ts (copied beside the test's files, with a shebang).
// Records every call in systemctl-calls.jsonl; exit-systemctl.txt sets its exit code.
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
fs.appendFileSync(
  path.join(dir, 'systemctl-calls.jsonl'),
  JSON.stringify({ args: process.argv.slice(2), env: process.env }) + '\n',
);
const exit = path.join(dir, 'exit-systemctl.txt');
process.exit(fs.existsSync(exit) ? Number(fs.readFileSync(exit, 'utf8')) : 0);
