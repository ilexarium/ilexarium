// A fake `sudo` for laris-helper.spec.ts (copied into the test's bin folder as `sudo`, with a
// shebang). Like the real ones (sudo and sudo-rs, checked), `-S -p '' -- <program>` reads one
// line per try — "right" is the password, three tries — then runs the program, which reads the
// rest of stdin. Records each call (args, the lines it read) in sudo-calls.jsonl.
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

if (!(args[0] === '-S' && args[1] === '-p' && args[2] === '' && args[3] === '--' && args[4])) {
  fail(`fake sudo: unexpected ${args.join(' ')}`);
}
for (let attempt = 1; ; attempt++) {
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
record();
// The program by Node itself, so the test's environment (its fake programs) reaches it.
const result = spawnSync(process.execPath, [args[4], ...args.slice(5)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
