// A fake program for laris-helper.spec.ts (copied into the test's bin folder under the name of the
// program it stands in for: systemd-run, systemctl, docker, du, rm, laris-backup.mts…). Records
// every call (args, cwd, stdin) in <name>-calls.jsonl; prints <name>-out.txt to stdout and
// <name>-err.txt to stderr if they exist, and exits with <name>-exit.txt (else 0) — each first as
// <name>-<its first argument>-… (`systemctl-list-units-out.txt`), for programs asked several ways.
// No require: copied as laris-backup.mts it runs as a module (getBuiltinModule works in both).
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');

const dir = path.dirname(path.dirname(process.argv[1]));
const name = path.basename(process.argv[1]);
const read = (file) => {
  for (const p of [
    path.join(dir, `${name}-${process.argv[2]}-${file}`),
    path.join(dir, `${name}-${file}`),
  ]) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return null;
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
// Not process.exit(): a long output to a pipe is written out first.
process.exitCode = Number(read('exit.txt') ?? 0);
