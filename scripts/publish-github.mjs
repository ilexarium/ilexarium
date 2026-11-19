// Publishes a version from the release folder (release-settings.json "folder") as a GitHub
// release on "github" (owner/name), its tag already pushed:
//
//   npm run release:github [-- <version>]   (package.json's by default)
//
// ship runs it after pushing the release commit and tag; run it by hand when that step stopped.
// A version already on GitHub is never replaced.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubReleaseArgs, githubReleaseFiles, isGithubRepo } from './lib/github-release.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SETTINGS = join(ROOT, 'release-settings.json');

const fail = (message) => {
  console.error(`release:github: ${message}`);
  process.exit(1);
};

if (!existsSync(SETTINGS)) fail(`no ${SETTINGS}`);
const { folder, github } = JSON.parse(readFileSync(SETTINGS, 'utf8'));
if (!isGithubRepo(github)) fail('release-settings.json needs "github": "<owner>/<name>"');
const version =
  process.argv[2] ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('usage: npm run release:github [-- <x.y.z>]');

const versionDir = join(folder, 'download', `v${version}`);
if (!existsSync(join(versionDir, 'manifest.json.minisig'))) {
  fail(`${version} isn't published in ${folder} (npm run ship)`);
}
const latestFile = join(folder, 'latest', 'download', 'latest.json');
const latest = JSON.parse(readFileSync(latestFile, 'utf8')).version === version;

const gh = (args) => execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
let exists = true;
try {
  gh(['release', 'view', `v${version}`, '--repo', github, '--json', 'tagName']);
} catch (error) {
  if (!/not found/i.test(String(error.stderr))) fail(String(error.stderr).trim());
  exists = false;
}
if (exists) fail(`v${version} is already on GitHub (${github}): a release is never replaced`);

const versionFiles = readdirSync(versionDir).map((name) => join(versionDir, name));
const stage = join(ROOT, 'release', 'github', `v${version}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const paths = githubReleaseFiles({ versionFiles, folder, latest }).map(([source, name]) => {
  copyFileSync(source, join(stage, name));
  return join(stage, name);
});
const notes = join(stage, 'NOTES.md');
execFileSync(
  'gh',
  githubReleaseArgs({
    repo: github,
    version,
    paths,
    notesFile: existsSync(notes) ? notes : undefined,
    latest,
  }),
  { cwd: ROOT, stdio: 'inherit' },
);
console.log(`v${version} is on GitHub: https://github.com/${github}/releases/tag/v${version}`);
