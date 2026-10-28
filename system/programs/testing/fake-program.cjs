// A fake program for laris-helper.spec.ts (copied into the test's bin folder under the name of the
// program it stands in for: systemd-run, systemctl, docker, du, rm, laris-backup.mts…). Records
// every call (args, cwd, stdin) in <name>-calls.jsonl; prints <name>-out.txt to stdout and
// <name>-err.txt to stderr if they exist, and exits with <name>-exit.txt (else 0).
// No require: copied as laris-backup.mts it runs as a module (getBuiltinModule works in both).
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');

const dir = path.dirname(path.dirname(process.argv[1]));
const name = path.basename(process.argv[1]);
const read = (file) => {
  const p = path.join(dir, `${name}-${file}`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch {
  // no stdin
}
fs.appendFileSync(
  path.join(dir, `${name}-calls.jsonl`),
  JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input }) + '\n',
);
const out = read('out.txt');
if (out) process.stdout.write(out);
const err = read('err.txt');
if (err) process.stderr.write(err);
process.exit(Number(read('exit.txt') ?? 0));
