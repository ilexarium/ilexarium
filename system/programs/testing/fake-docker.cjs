// A fake `docker` for ilex-backup.spec.ts (copied beside the test's files, with a shebang).
// Records every call in docker-calls.jsonl. `exec` prints a fake dump. `compose -p <project>`:
// `ps -q` prints a container id while <project> is in running.txt; `stop`, `start` and `up` change
// that; exit-<command>.txt sets an exit code; start-fails.txt makes the next N starts fail.
// `compose ls` prints compose-ls.json (or `[]`). `exec … psql` and `exec … pg_restore` read their
// stdin (kept in docker-stdin.jsonl; a restored dump in restored-dumps.txt), psql answers a query
// of the migrations with migrations.txt; exit-<program>[-once].txt sets their exit codes.
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
  const rest = args.slice(1).filter((a) => a !== '-i');
  const program = rest[1];
  const exitOf = (name) => {
    const once = file(`exit-${name}-once.txt`);
    if (fs.existsSync(once)) {
      const code = Number(fs.readFileSync(once, 'utf8'));
      fs.rmSync(once);
      return code;
    }
    return Number(read(`exit-${name}.txt`, '0'));
  };
  if (program === 'psql' || program === 'pg_restore') {
    const stdin = fs.readFileSync(0, 'utf8');
    fs.appendFileSync(file('docker-stdin.jsonl'), JSON.stringify({ args, stdin }) + '\n');
    if (program === 'pg_restore') fs.appendFileSync(file('restored-dumps.txt'), stdin);
    if (program === 'psql' && stdin.includes('_prisma_migrations')) {
      process.stdout.write(read('migrations.txt', ''));
    }
    process.exit(exitOf(program));
  }
  if (program === 'pg_isready') process.exit(0);
  process.stdout.write(read('dump.txt', 'PGDMP fake dump\n'));
  process.exit(Number(read('exit-exec.txt', '0')));
}
if (args[0] === 'compose' && args[1] === 'ls') {
  process.stdout.write(read('compose-ls.json', '[]'));
  process.exit(Number(read('exit-ls.txt', '0')));
}
if (args[0] === 'compose') {
  const project = args[2];
  let at = 3;
  while (args[at] === '-f') at += 2;
  const command = args[at];
  const exit = Number(read(`exit-${command}.txt`, '0'));
  if (command === 'ps') {
    if (running().includes(project)) process.stdout.write('c0ffee\n');
  } else if (command === 'stop') {
    if (exit === 0) setRunning(running().filter((p) => p !== project));
  } else if (command === 'start' || command === 'up') {
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
