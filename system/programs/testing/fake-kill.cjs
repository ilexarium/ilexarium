// A fake `kill` for laris-helper.spec.ts (copied into the test's bin folder as `kill`). Records
// every call (args, the environment it got) in kill-calls.jsonl. PID 404: no such process, 403: not
// permitted, 500: some other failure; any other PID succeeds.
const fs = require('node:fs');
const path = require('node:path');

const dir = path.dirname(__dirname);
const args = process.argv.slice(2);
fs.appendFileSync(
  path.join(dir, 'kill-calls.jsonl'),
  JSON.stringify({ args, env: process.env }) + '\n',
);
const pid = args.at(-1);
if (pid === '404') {
  process.stderr.write(`kill: (${pid}) - No such process\n`);
  process.exit(1);
}
if (pid === '403') {
  process.stderr.write(`kill: (${pid}) - Operation not permitted\n`);
  process.exit(1);
}
if (pid === '500') {
  process.stderr.write('kill: something else\n');
  process.exit(2);
}
