// Copies the release folder (release-settings.json "folder") to the server, into the site's
// releases/ (https://ilexarium.com/releases, /get-ilex.sh at the top):
//
//   npm run release:upload [-- --dry-run]
//
// Where to: release-settings.json "upload", e.g.
//   "upload": {"target": "deploy@ilexarium.com", "ssh": ["-p", "2222"]}
// The deploy user's key may only rsync into the site's folder. The versions go first, then
// latest/ and get-ilex.sh, so latest never names files that aren't there yet. Nothing on the
// server is deleted, and a version already there is never replaced.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SETTINGS = join(ROOT, 'release-settings.json');

const fail = (message) => {
  console.error(`release:upload: ${message}`);
  process.exit(1);
};

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' } } });
if (!existsSync(SETTINGS)) fail(`no ${SETTINGS}`);
const { folder, upload } = JSON.parse(readFileSync(SETTINGS, 'utf8'));
if (typeof folder !== 'string' || !existsSync(join(folder, 'latest', 'download', 'latest.json'))) {
  fail('no published release in the release folder (npm run ship)');
}
if (
  typeof upload?.target !== 'string' ||
  !/^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$/.test(upload.target) ||
  !(upload.ssh ?? []).every((arg) => typeof arg === 'string')
) {
  fail('release-settings.json needs "upload": {"target": "<user>@<host>", "ssh": [...]}');
}

// rsync joins -e into one command line: our own settings, never anything from elsewhere.
const ssh = ['ssh', ...(upload.ssh ?? [])].join(' ');
const rsync = (options, source, destination) =>
  execFileSync(
    'rsync',
    [
      '--recursive',
      '--times',
      '--chmod=D755,F644',
      '--itemize-changes',
      ...(values['dry-run'] ? ['--dry-run'] : []),
      ...options,
      '-e',
      ssh,
      source,
      `${upload.target}:releases/${destination}`,
    ],
    { stdio: 'inherit' },
  );

try {
  rsync(['--ignore-existing'], `${join(folder, 'download')}/`, 'download/');
  // Both files of latest/ swapped in at the end, together.
  rsync(['--delay-updates'], `${join(folder, 'latest')}/`, 'latest/');
  rsync([], join(folder, 'get-ilex.sh'), 'get-ilex.sh');
} catch {
  fail('the upload stopped; run it again (what is already there is skipped)');
}
console.log(values['dry-run'] ? 'Dry run: nothing was copied' : `Uploaded to ${upload.target}`);
