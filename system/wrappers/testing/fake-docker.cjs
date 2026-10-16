// A fake `docker` for homelab-backup.spec.ts (copied beside the test's files, with a shebang).
// Records every call in docker-calls.jsonl. `exec` prints a fake dump. `compose -p <project>`:
// `ps -q` prints a container id while <project> is in running.txt; `stop` and `start` change
// that; exit-<command>.txt sets an exit code; start-fails.txt makes the next N starts fail.
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(
  path.join(dir, 'docker-calls.jsonl'),
  JSON.stringify({ args, env: process.env }) + '\n',
);
const file = (name) => path.join(dir, name);
const read = (name, fallback) =>
  fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : fallback;
const running = () => read('running.txt', '').split('\n').filter(Boolean);
const setRunning = (list) => fs.writeFileSync(file('running.txt'), list.join('\n'));

if (args[0] === 'exec') {
  process.stdout.write('PGDMP fake dump\n');
  process.exit(Number(read('exit-exec.txt', '0')));
}
if (args[0] === 'compose') {
  const project = args[2];
  const command = args[3];
  const exit = Number(read(`exit-${command}.txt`, '0'));
  if (command === 'ps') {
    if (running().includes(project)) process.stdout.write('c0ffee\n');
  } else if (command === 'stop') {
    if (exit === 0) setRunning(running().filter((p) => p !== project));
  } else if (command === 'start') {
    const fails = Number(read('start-fails.txt', '0'));
    if (fails > 0) {
      fs.writeFileSync(file('start-fails.txt'), String(fails - 1));
      process.exit(1);
    }
    if (exit === 0) setRunning([...running().filter((p) => p !== project), project]);
  }
  process.exit(exit);
}
process.exit(1);
