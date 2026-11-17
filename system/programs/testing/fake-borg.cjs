// A fake `borg` for ilex-backup.spec.ts (copied beside the test's files, with a shebang).
// Records every call (args, environment, folder) in borg-calls.jsonl; keeps "archives" in
// archives.json (name → its create command line); behaviour per command from files:
// exit-<command>.txt (exit code), logs-<command>.jsonl (stderr log lines), repo-id.txt,
// kill-<command>.txt (kills the program that started it: a hard kill, power loss),
// die-<command>.txt (Borg itself is killed with SIGKILL, as the out-of-memory killer does, after
// what it got done: a partial extract, no archive), hang-<command>.txt (it works until a signal
// ends it: a stop while it runs). exit-<command>-once.txt and logs-<command>-once.jsonl count
// for its next call only (a full disk, then room); unheld.txt lists folders an extract leaves out
// (unreadable when backed up).
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

const once = (name) => {
  const text = read(name, null);
  if (text !== null) fs.rmSync(path.join(dir, name));
  return text;
};
const onceLogs = once(`logs-${command}-once.jsonl`);
const onceExit = once(`exit-${command}-once.txt`);
for (const line of (onceLogs ?? read(`logs-${command}.jsonl`, '')).split('\n').filter(Boolean)) {
  process.stderr.write(line + '\n');
}
if (fs.existsSync(path.join(dir, `kill-${command}.txt`))) process.kill(process.ppid, 'SIGKILL');
if (fs.existsSync(path.join(dir, `hang-${command}.txt`))) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
}
const dies = fs.existsSync(path.join(dir, `die-${command}.txt`));
const exit = Number(onceExit ?? read(`exit-${command}.txt`, '0'));
const archivesFile = path.join(dir, 'archives.json');
const archives = () => JSON.parse(read('archives.json', '{}'));
const target = args.find((a) => a.includes('::'));
const name = target ? target.split('::')[1] : '';
const glob = () =>
  args.includes('--glob-archives')
    ? args[args.indexOf('--glob-archives') + 1].replace(/\*$/, '')
    : '';

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
    if (exit >= 2 || dies) break;
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
    // A disk mounted while it extracts: mountinfo-after-extract.txt becomes the mountinfo.
    const after = read('mountinfo-after-extract.txt', null);
    if (after !== null) fs.writeFileSync(path.join(dir, 'mountinfo'), after);
    const line = archives()[name];
    const sources = line.slice(line.findIndex((a) => a.endsWith('::' + name)) + 1);
    // The folders it holds: those its comment lists (a folder inside another one included).
    const at = line.indexOf('--comment');
    const held = at >= 0 ? JSON.parse(line[at + 1]) : sources;
    const wanted = args.slice(args.indexOf(target) + 1).map((relative) => `/${relative}`);
    const unheld = read('unheld.txt', '').split('\n').filter(Boolean);
    const extracted = (
      wanted.length
        ? held.filter((f) => wanted.some((w) => f === w || f.startsWith(`${w}/`)))
        : held
    ).filter((f) => !unheld.includes(f));
    for (const absolute of extracted) {
      const folder = path.join(process.cwd(), absolute.slice(1));
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, exit >= 2 || dies ? 'partial.txt' : 'restored.txt'), name);
    }
    break;
  }
  case 'config':
    // Asked for a value (no value given): the one in borg-config.txt, if any.
    if (args.length === 4) process.stdout.write(read('borg-config.txt', ''));
    break;
  case 'delete': {
    const all = archives();
    for (const n of Object.keys(all)) if (n.startsWith(glob())) delete all[n];
    fs.writeFileSync(archivesFile, JSON.stringify(all));
    break;
  }
}
if (dies) process.kill(process.pid, 'SIGKILL');
process.exit(exit);
