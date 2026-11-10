// A fake `sudo` for ilex-helper.spec.ts (copied into the test's bin folder as `sudo`, with a
// shebang). Like the real ones (sudo and sudo-rs, checked), `[-k] -S -p '' -- <program>` reads one
// line per try — "right" is the password, three tries — then runs the program, which reads the
// rest of stdin. Like them without a terminal, a success is cached (the file `cached`): without
// -k, the next call asks nothing. Records each call (args, the lines it read) in sudo-calls.jsonl,
// and writes the file `ended` once the program it ran has ended.
// not-allowed.txt: the account isn't in sudoers. rs.txt: sudo-rs's messages.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.dirname(__dirname);
const args = process.argv.slice(2);
const has = (name) => fs.existsSync(path.join(dir, name));
const rs = has('rs.txt');
const tries = [];
const record = () =>
  fs.appendFileSync(
    path.join(dir, 'sudo-calls.jsonl'),
    JSON.stringify({ args, input: tries.join('') }) + '\n',
  );
const fail = (message) => {
  record();
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

/** One line, byte by byte: nothing more is taken from stdin. */
function readLine() {
  const byte = Buffer.alloc(1);
  let line = '';
  for (;;) {
    let read;
    try {
      read = fs.readSync(0, byte, 0, 1, null);
    } catch (error) {
      if (error.code === 'EAGAIN') continue;
      read = 0;
    }
    if (read === 0) return line === '' ? null : line;
    line += byte.toString('latin1');
    if (line.endsWith('\n')) return line;
  }
}

const cached = path.join(dir, 'cached');
const ignoreCache = args[0] === '-k';
const rest = ignoreCache ? args.slice(1) : args;
if (!(rest[0] === '-S' && rest[1] === '-p' && rest[2] === '' && rest[3] === '--' && rest[4])) {
  fail(`fake sudo: unexpected ${args.join(' ')}`);
}
const asks = ignoreCache || !fs.existsSync(cached);
for (let attempt = 1; asks; attempt++) {
  const line = readLine();
  if (line === null)
    fail(rs ? 'sudo-rs: no password was provided' : 'sudo: no password was provided');
  tries.push(line);
  if (line === 'right\n') break;
  if (attempt === 3) {
    fail(
      rs
        ? 'sudo-rs: Maximum 3 incorrect authentication attempts'
        : 'sudo: 3 incorrect password attempts',
    );
  }
  process.stderr.write(rs ? 'sudo: Authentication failed, try again.\n' : 'Sorry, try again.\n');
}
if (has('not-allowed.txt')) {
  fail(
    rs ? "sudo-rs: I'm sorry anna. I'm afraid I can't do that" : 'anna is not in the sudoers file.',
  );
}
fs.writeFileSync(cached, '');
record();
// The program by Node itself, so the test's environment (its fake programs) reaches it.
const result = spawnSync(process.execPath, [rest[4], ...rest.slice(5)], { stdio: 'inherit' });
fs.writeFileSync(path.join(dir, 'ended'), '');
process.exit(result.status ?? 1);
