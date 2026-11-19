// Publishes a version from the release folder (release-settings.json "folder") as a GitHub
// release on "github" (owner/name), its tag already pushed:
//
//   npm run release:github [-- <version>]   (package.json's by default)
//
// ship runs it after pushing the release commit and tag; run it by hand when that step stopped.
// A version already on GitHub is never replaced.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  githubReleaseArgs,
  githubReleaseFiles,
  isGithubRepo,
  newerVersion,
} from './lib/github-release.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SETTINGS = join(ROOT, 'release-settings.json');

const fail = (message) => {
  console.error(`release:github: ${message}`);
  process.exit(1);
};

if (!existsSync(SETTINGS)) fail(`no ${SETTINGS}`);
const { folder, github } = JSON.parse(readFileSync(SETTINGS, 'utf8'));
if (!isGithubRepo(github)) fail('release-settings.json needs "github": "<owner>/<name>"');
if (typeof folder !== 'string' || !existsSync(folder)) {
  fail('release-settings.json needs "folder", the release folder');
}
const version =
  process.argv[2] ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('usage: npm run release:github [-- <x.y.z>]');

const versionDir = join(folder, 'download', `v${version}`);
if (!existsSync(join(versionDir, 'manifest.json.minisig'))) {
  fail(`${version} isn't published in ${folder} (npm run ship)`);
}

const gh = (args) => {
  try {
    return { out: execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { error: String(error.stderr ?? error.message).trim() };
  }
};
const repo = gh(['repo', 'view', github, '--json', 'name']);
if (repo.error) fail(`${github} isn't reachable with gh (gh auth status): ${repo.error}`);

const existing = gh(['release', 'view', `v${version}`, '--repo', github, '--json', 'isDraft']);
if (!existing.error) {
  fail(
    JSON.parse(existing.out).isDraft
      ? `a draft of v${version} is on GitHub, left by a run that stopped: delete it (gh release delete v${version} --repo ${github}), then run this again`
      : `v${version} is already on GitHub (${github}): a release is never replaced`,
  );
}
if (!/release not found/i.test(existing.error)) fail(existing.error);

// Latest only when it's the folder's latest and newer than GitHub's: a stale folder never moves
// machines back.
const folderLatest = JSON.parse(
  readFileSync(join(folder, 'latest', 'download', 'latest.json'), 'utf8'),
).version;
const githubLatest = gh(['release', 'view', '--repo', github, '--json', 'tagName']);
if (githubLatest.error && !/release not found/i.test(githubLatest.error)) fail(githubLatest.error);
const latest =
  folderLatest === version &&
  (Boolean(githubLatest.error) ||
    newerVersion(version, JSON.parse(githubLatest.out).tagName.replace(/^v/, '')));

const versionFiles = readdirSync(versionDir).map((name) => join(versionDir, name));
const paths = githubReleaseFiles({ versionFiles, folder, latest });
const missing = paths.filter((path) => !existsSync(path));
if (missing.length > 0) fail(`missing in the release folder: ${missing.join(', ')}`);
const notes = join(versionDir, 'NOTES.md');
try {
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
} catch {
  fail(`v${version} wasn't released on GitHub (see gh's message above)`);
}
console.log(`v${version} is on GitHub: https://github.com/${github}/releases/tag/v${version}`);
