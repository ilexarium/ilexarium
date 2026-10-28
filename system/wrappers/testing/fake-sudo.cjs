// A fake `sudo` for laris-helper.spec.ts (copied into the test's bin folder as `sudo`, with a
// shebang). Records every call (args, stdin) in sudo-calls.jsonl. The password is "right";
// `-S -v` with it unlocks (the file `unlocked`), `-k` locks, `-n -- <program> …` runs the program
// while unlocked. not-allowed.txt: the account isn't in sudoers. rs.txt: sudo-rs's messages.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.dirname(__dirname);
const args = process.argv.slice(2);
const input = args.includes('-S') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(path.join(dir, 'sudo-calls.jsonl'), JSON.stringify({ args, input }) + '\n');
const has = (name) => fs.existsSync(path.join(dir, name));
const rs = has('rs.txt');
const unlocked = path.join(dir, 'unlocked');
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (args[0] === '-k') {
  fs.rmSync(unlocked, { force: true });
  process.exit(0);
}
if (args[0] === '-S' && args[1] === '-v') {
  process.stderr.write(rs ? '[sudo: authenticate] Password:' : '[sudo] password for anna: ');
  if (input !== 'right\n') {
    fail(
      rs
        ? 'sudo-rs: Authentication failed, try again.'
        : 'Sorry, try again.\nsudo: 1 incorrect password attempt',
    );
  }
  if (has('not-allowed.txt')) {
    fail(
      rs
        ? "sudo-rs: I'm sorry anna. I'm afraid I can't do that"
        : 'anna is not in the sudoers file.',
    );
  }
  fs.writeFileSync(unlocked, '');
  process.exit(0);
}
if (args[0] === '-n' && args[1] === '--') {
  if (has('not-allowed.txt')) fail('Sorry, user anna may not run sudo on laris.');
  if (!fs.existsSync(unlocked)) {
    fail(
      rs ? 'sudo-rs: authentication failed: interaction required' : 'sudo: a password is required',
    );
  }
  const result = spawnSync(args[2], args.slice(3), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
fail(`fake sudo: unexpected ${args.join(' ')}`);
