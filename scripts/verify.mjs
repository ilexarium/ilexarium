// Runs the whole suite and records the commit it passed at, which `npm run ship` requires:
//
//   npm run verify [-- --only <part>,…]
//
// Parts, in this order: lint (the workspaces and the programs' type check), format, unit (every
// workspace's unit tests, the web app's, the programs' and the helper's included), e2e (the
// server's integration and e2e tests: the dev services up, npm run db:up, and Borg installed —
// a skipped test fails it) and install (tools/vm/test-install.sh --container). The shared packages
// are built first. Run where the server's tests run: on Linux, or on a Mac in the dev container
// (npm run srv -- npm run verify).
//
// A part that passes is recorded in .dev/verified.json with the commit, only when the tree had no
// changes from the start of the run to that point.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  notRecordable,
  PARTS,
  readStamp,
  STAMP_FILE,
  withPassed,
  writeStamp,
} from './lib/verified.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const E2E_RESULTS = join(ROOT, '.dev', 'e2e-results.json');

const fail = (message) => {
  console.error(`verify: ${message}`);
  process.exit(1);
};
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
};
const state = () => ({
  commit: git('rev-parse', 'HEAD'),
  clean: git('status', '--porcelain') === '',
});
const run = (command, args) => {
  console.log(`\n==> ${command} ${args.join(' ')}`);
  return spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' }).status === 0;
};

// Each part: true when it passed.
const CHECKS = {
  lint: () => run('npm', ['run', 'lint']),
  format: () => run('npm', ['run', 'format:check']),
  unit: () => run('npm', ['test', '--workspaces', '--if-present']),
  e2e: () => {
    rmSync(E2E_RESULTS, { force: true });
    const passed = run('npm', [
      'run',
      'test:e2e',
      '-w',
      '@ilex/server',
      '--',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${E2E_RESULTS}`,
    ]);
    if (!passed) return false;
    // Tests skip themselves when a dev service or Borg is missing: here that's a failure.
    const { numTotalTests, numPendingTests, numTodoTests } = JSON.parse(
      readFileSync(E2E_RESULTS, 'utf8'),
    );
    const skipped = numPendingTests + numTodoTests;
    if (numTotalTests === 0 || skipped > 0) {
      console.error(
        `verify: ${skipped} of ${numTotalTests} e2e tests were skipped: start the dev services (npm run db:up) and install Borg`,
      );
      return false;
    }
    return true;
  },
  install: () => run('bash', ['tools/vm/test-install.sh', '--container']),
};

const { values } = parseArgs({ options: { only: { type: 'string' } } });
const parts = values.only ? values.only.split(',') : PARTS;
const unknown = parts.filter((part) => !PARTS.includes(part));
if (parts.length === 0 || unknown.length > 0) {
  fail(`usage: npm run verify [-- --only <part>,…] — parts: ${PARTS.join(', ')}`);
}

const before = state();
if (!before.clean) {
  console.warn('verify: the tree has changes that are not committed: nothing will be recorded');
}
if (!run('npm', ['run', 'build:shared'])) fail('npm run build:shared failed');
for (const part of PARTS.filter((p) => parts.includes(p))) {
  if (!CHECKS[part]()) fail(`${part} failed`);
  const problem = notRecordable(before, state());
  if (problem) {
    console.warn(`verify: ${part} passed, not recorded: ${problem}`);
    continue;
  }
  writeStamp(
    STAMP_FILE,
    withPassed(readStamp(STAMP_FILE), part, before.commit, new Date().toISOString()),
  );
  console.log(`verify: ${part} passed at ${before.commit}`);
}
console.log(`\nverify: passed: ${parts.join(', ')}`);
