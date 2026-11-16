// Builds, signs and publishes a new release in one go:
//
//   npm run ship -- <x.y.z> [--notes <file.md>]
//
// Only from a commit pushed as main, at which the CI workflow on GitHub passes every job, the
// install test included: ship starts that run and waits for it (about 20 minutes).
// Where it comes from, the key and the folder: release-settings.json at the repository's top (not
// in git) — {"releaseUrl": "https://…", "key": "<release.key>", "folder": "<release folder>"},
// and with "upload" (scripts/upload-release.mjs) the folder is copied to the server at the end.
// The passphrase is asked first and checked against the key, so CI and the build run unattended; the
// version is committed and tagged only once the release is published.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openKey } from './lib/key-file.mjs';
import { passphrase } from './lib/passphrase.mjs';
import { passCi } from './lib/github-ci.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SETTINGS = join(ROOT, 'release-settings.json');

const fail = (message) => {
  console.error(`ship: ${message}`);
  process.exit(1);
};
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const run = (command, args, env = {}) =>
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { notes: { type: 'string' } },
});
const [version] = positionals;
if (positionals.length !== 1 || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail('usage: npm run ship -- <x.y.z> [--notes <file.md>]');
}
if (!existsSync(SETTINGS)) {
  fail(
    `no ${SETTINGS} — {"releaseUrl": "https://…", "key": "<release.key>", "folder": "<folder>"}`,
  );
}
const { releaseUrl, key, folder, upload } = JSON.parse(readFileSync(SETTINGS, 'utf8'));
if (typeof releaseUrl !== 'string' || typeof key !== 'string' || typeof folder !== 'string') {
  fail('release-settings.json needs releaseUrl, key and folder');
}
if (!existsSync(key)) fail(`no release key at ${key}`);
if (!existsSync(folder)) fail(`no release folder at ${folder}`);
if (values.notes && !existsSync(values.notes)) fail(`no notes at ${values.notes}`);

if (git('status', '--porcelain') !== '') fail('the working tree has changes: commit them first');
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('releases are built from main');
const head = git('rev-parse', 'HEAD');
const pushed = git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0];
if (pushed !== head) fail(`main on GitHub is at ${pushed || 'nothing'}, not ${head}: push first`);
const current = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const latestFile = join(folder, 'latest', 'download', 'latest.json');
const published = existsSync(latestFile)
  ? JSON.parse(readFileSync(latestFile, 'utf8')).version
  : '0.0.0';
if (!newer(version, current) || !newer(version, published)) {
  fail(`${version} isn't newer than ${current} (package.json) and ${published} (published)`);
}

const secret = await passphrase('Passphrase of the release key: ').catch((error) =>
  fail(error.message),
);
try {
  openKey(readFileSync(key, 'utf8'), secret);
} catch (error) {
  fail(error.message);
}

const gh = (args) => execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8' });
try {
  await passCi({ gh, sha: head, sleep: (ms) => new Promise((done) => setTimeout(done, ms)) });
} catch (error) {
  fail(`not released: ${error.message}`);
}
console.log(`CI passed at ${head}`);

console.log(`\nShipping ${version} (published now: ${published})`);
// Earlier builds and the install test's leftovers: published versions live in the folder.
rmSync(join(ROOT, 'release'), { recursive: true, force: true });
run('npm', ['version', version, '--no-git-tag-version']);
try {
  run('npm', ['run', 'release'], { RELEASE_URL: releaseUrl });
  run(
    'npm',
    ['run', 'release:sign', '--', '--key', key, ...(values.notes ? ['--notes', values.notes] : [])],
    { RELEASE_KEY_PASSPHRASE: secret },
  );
  run('npm', ['run', 'release:publish', '--', resolve(folder)]);
} catch {
  // Nothing published: the version goes back, the tree is as it was.
  git('checkout', '--', 'package.json', 'package-lock.json');
  fail(`${version} was not published; package.json is back at ${current}`);
}
git('commit', '-q', '-m', `Release ${version}`, '--', 'package.json', 'package-lock.json');
git('tag', `v${version}`);
console.log(`\n${version} is published and committed (tag v${version})`);
if (upload) {
  // After the commit: the version is in the folder for good, and an upload that stops is run
  // again on its own.
  try {
    run('npm', ['run', 'release:upload']);
  } catch {
    fail(`${version} isn't fully on the server: npm run release:upload, then push`);
  }
}
console.log('Push with: git push --follow-tags');
