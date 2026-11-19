// A published version as a GitHub release: the same files as the release folder's
// download/v<version>/, plus — for the latest — latest.json(.minisig) and get-ilex.sh, so GitHub's
// releases/latest/download/<file> answers what machines and get-ilex.sh ask for.
import { basename, join } from 'node:path';

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export const isGithubRepo = (value) => typeof value === 'string' && REPO.test(value);

// [source path, name on GitHub] — GitHub names a file by its own name, so the copies get theirs.
export function githubReleaseFiles({ versionFiles, folder, latest }) {
  const files = versionFiles.map((path) => [path, basename(path)]);
  if (!latest) return files;
  const download = join(folder, 'latest', 'download');
  return [
    ...files,
    [join(download, 'latest.json'), 'latest.json'],
    [join(download, 'latest.json.minisig'), 'latest.json.minisig'],
    [join(folder, 'get-ilex.sh'), 'get-ilex.sh'],
  ];
}

export function githubReleaseArgs({ repo, version, paths, notesFile, latest }) {
  return [
    'release',
    'create',
    `v${version}`,
    '--repo',
    repo,
    '--verify-tag',
    '--title',
    `v${version}`,
    // Without notes gh would open an editor.
    ...(notesFile ? ['--notes-file', notesFile] : ['--notes', '']),
    `--latest=${latest}`,
    ...paths,
  ];
}
