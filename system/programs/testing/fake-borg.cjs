// A fake `borg` for ilex-backup.spec.ts (copied beside the test's files, with a shebang).
// Records every call (args, environment, folder) in borg-calls.jsonl; keeps "archives" in
// archives.json (name → its create command line); behaviour per command from files:
// exit-<command>.txt (exit code), logs-<command>.jsonl (stderr log lines), repo-id.txt,
// kill-<command>.txt (kills the program that started it: a hard kill, power loss).
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const args = process.argv.slice(2);
const command = args[0];
fs.appendFileSync(
  path.join(dir, 'borg-calls.jsonl'),
  JSON.stringify({ args, env: process.env, cwd: process.cwd() }) + '\n',
);
const read = (name, fallback) =>
  fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : fallback;
const log = (levelname, message, msgid = '') =>
  process.stderr.write(JSON.stringify({ type: 'log_message', levelname, message, msgid }) + '\n');

// Like Borg: the passphrase comes from BORG_PASSCOMMAND ("<cat> <file>").
const passFile = (process.env.BORG_PASSCOMMAND || '').split(' ')[1];
if (!passFile || !fs.existsSync(passFile)) {
  log('ERROR', 'Passphrase supplied ... is incorrect.', 'PassphraseWrong');
  process.exit(2);
}

for (const line of read(`logs-${command}.jsonl`, '').split('\n').filter(Boolean)) {
  process.stderr.write(line + '\n');
}
if (fs.existsSync(path.join(dir, `kill-${command}.txt`))) process.kill(process.ppid, 'SIGKILL');
const exit = Number(read(`exit-${command}.txt`, '0'));
const archivesFile = path.join(dir, 'archives.json');
const archives = () => JSON.parse(read('archives.json', '{}'));
const target = args.find((a) => a.includes('::'));
const name = target ? target.split('::')[1] : '';
const glob = () => args[args.indexOf('--glob-archives') + 1].replace(/\*$/, '');

switch (command) {
  case 'init': {
    const repo = args[args.length - 1];
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'config'),
      `[repository]\nid = ${read('repo-id.txt', 'a'.repeat(64))}\n`,
    );
    break;
  }
  case 'create': {
    if (exit >= 2) break;
    const all = archives();
    all[name] = ['/usr/bin/borg', ...args];
    fs.writeFileSync(archivesFile, JSON.stringify(all));
    process.stdout.write(
      JSON.stringify({
        archive: {
          name,
          stats: { original_size: 1000, compressed_size: 600, deduplicated_size: 100 },
        },
      }),
    );
    break;
  }
  case 'list':
    process.stdout.write(
      JSON.stringify({
        archives: Object.keys(archives())
          .filter((n) => n.startsWith(glob()))
          .map((n) => ({ name: n })),
      }),
    );
    break;
  case 'info': {
    const line = archives()[name];
    if (!line) {
      log('ERROR', `Archive ${name} does not exist`, 'Archive.DoesNotExist');
      process.exit(2);
    }
    const at = line.indexOf('--comment');
    const comment = at >= 0 ? line[at + 1] : '';
    process.stdout.write(JSON.stringify({ archives: [{ name, command_line: line, comment }] }));
    break;
  }
  case 'extract': {
    const line = archives()[name];
    const sources = line.slice(line.findIndex((a) => a.endsWith('::' + name)) + 1);
    // The folders it holds: those its comment lists (a folder inside another one included).
    const at = line.indexOf('--comment');
    const held = at >= 0 ? JSON.parse(line[at + 1]) : sources;
    const wanted = args.slice(args.indexOf(target) + 1).map((relative) => `/${relative}`);
    const extracted = wanted.length
      ? held.filter((f) => wanted.some((w) => f === w || f.startsWith(`${w}/`)))
      : held;
    for (const absolute of extracted) {
      const folder = path.join(process.cwd(), absolute.slice(1));
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, exit >= 2 ? 'partial.txt' : 'restored.txt'), name);
    }
    break;
  }
  case 'delete': {
    const all = archives();
    for (const n of Object.keys(all)) if (n.startsWith(glob())) delete all[n];
    fs.writeFileSync(archivesFile, JSON.stringify(all));
    break;
  }
}
process.exit(exit);
